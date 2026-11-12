import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItemShares } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { lockOrder, mapSettlementGuard, recomputeAndBumpOrder } from "../repositories/order-repository";
import { assertOrderOpen } from "../rules/order-lifecycle";
import { assertPermission } from "./access";

/**
 * Phase 20 (policy 17): voids one share of a shared item, for money only. The original item,
 * its kitchen work and its stock are untouched (it was made once). The check is recomputed.
 */
export async function voidItemShare(
  database: Database,
  actor: Actor,
  orderId: string,
  shareId: string,
  input: { reason: string; expectedVersion: number; shareVersion: number },
) {
  assertPermission(actor, "orders.void");

  const reason = input.reason.trim();

  if (reason.length === 0 || reason.length > 300) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason of 1 to 300 characters.");
  }

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const [share] = await transaction
      .select()
      .from(orderItemShares)
      .where(and(eq(orderItemShares.id, shareId), eq(orderItemShares.orderId, orderId)))
      .for("update");

    if (!share) {
      throw new NotFoundError("item share");
    }

    if (share.status !== "ACTIVE") {
      throw new BusinessRuleError("SHARE_ALREADY_VOIDED", "That share has already been voided.");
    }

    if (share.version !== input.shareVersion) {
      throw new ConcurrencyError("item share", shareId);
    }

    const now = new Date();

    await transaction
      .update(orderItemShares)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: actor.userId,
        voidReason: reason,
        version: sql`${orderItemShares.version} + 1`,
      })
      .where(eq(orderItemShares.id, shareId))
      .catch((error: unknown) => {
        throw mapSettlementGuard(error);
      });

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    await recordAudit(transaction, actor, {
      action: "orders.share-voided",
      entityId: orderId,
      after: { shareId, orderItemId: share.orderItemId, amount: share.amount, reason },
    });

    return { orderVersion: updated.version };
  });
}
