import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItemDiscounts, orderItems, orderItemShares } from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrder, recomputeAndBumpOrder } from "@/modules/orders/repositories/order-repository";
import { MAX_SHARES, MIN_SHARES, splitIntoShares } from "@/modules/orders/rules/item-shares";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { assertPermission } from "@/modules/orders/services/access";
import { createOrderInTransaction } from "@/modules/orders/services/order-service";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

// Phase 20 (policy 17, D16): share one sent item between checks on one Table Session. The
// original becomes SPLIT and leaves the totals; its equal shares carry the money (cents by
// largest remainder) to the checks chosen for them, with the original's tax snapshot. Kitchen
// work, consumption and modifier snapshots stay with the original: no ticket, ledger row or
// snapshot is written. Every order involved is locked in UUID order and recomputed. A retry
// with the same key returns the first result.

export const SPLIT_ITEM_SCOPE = "orders.split-item";

export type ShareTarget = { orderId: string; expectedVersion: number } | { newCheck: true };

export type SplitItemInput = {
  shareCount: number;
  /** One per share, in share order. Every `newCheck` share goes to one new check. */
  targets: ShareTarget[];
  expectedVersion: number;
  idempotencyKey: string;
};

export type SplitItemResult = {
  orderItemId: string;
  splitGroupId: string;
  shares: { shareId: string; shareNumber: number; orderId: string; amount: string }[];
  orders: { orderId: string; orderNumber: number; version: number }[];
};

type Locked = Awaited<ReturnType<typeof lockOrder>>;

/** Locks the given orders in UUID order, so two splits or moves can't deadlock. */
async function lockInOrder(
  transaction: DatabaseTransaction,
  actor: Actor,
  wanted: ReadonlyMap<string, number>,
): Promise<Map<string, Locked>> {
  const locked = new Map<string, Locked>();

  for (const id of [...wanted.keys()].sort()) {
    locked.set(id, await lockOrder(transaction, actor, id, wanted.get(id)!));
  }

  return locked;
}

export async function splitOrderItem(
  database: Database,
  actor: Actor,
  sourceOrderId: string,
  orderItemId: string,
  input: SplitItemInput,
): Promise<SplitItemResult & { replayed: boolean }> {
  assertPermission(actor, "orders.move-items");

  const wantsNewCheck = input.targets.some((target) => "newCheck" in target);

  if (wantsNewCheck) {
    assertPermission(actor, "orders.create");
  }

  if (
    !Number.isInteger(input.shareCount) ||
    input.shareCount < MIN_SHARES ||
    input.shareCount > MAX_SHARES ||
    input.targets.length !== input.shareCount
  ) {
    throw new BusinessRuleError(
      "INVALID_SHARE_COUNT",
      `Share an item ${MIN_SHARES} to ${MAX_SHARES} ways, choosing a check for each share.`,
    );
  }

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<SplitItemResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: SPLIT_ITEM_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { sourceOrderId, orderItemId, shareCount: input.shareCount, targets: input.targets, expectedVersion: input.expectedVersion },
      },
      async () => {
        const wanted = new Map<string, number>([[sourceOrderId, input.expectedVersion]]);

        for (const target of input.targets) {
          if ("orderId" in target && target.orderId !== sourceOrderId) {
            if (wanted.has(target.orderId) && wanted.get(target.orderId) !== target.expectedVersion) {
              throw new BusinessRuleError("INVALID_TARGETS", "A check was named twice with different versions.");
            }

            wanted.set(target.orderId, target.expectedVersion);
          }
        }

        const locked = await lockInOrder(transaction, actor, wanted);
        const source = locked.get(sourceOrderId)!;

        assertOrderOpen(source.status);

        if (source.tableSessionId === null || source.orderType === "TAKEOUT") {
          throw new BusinessRuleError("TAKEOUT_CANNOT_SPLIT", "Takeout orders can't be split into checks.");
        }

        if (wantsNewCheck) {
          const created = await createOrderInTransaction(transaction, actor, {
            orderType: source.orderType as "DINE_IN" | "BAR",
            tableSessionId: source.tableSessionId,
          });

          locked.set(created.id, await lockOrder(transaction, actor, created.id, created.version));
          wanted.set(created.id, created.version);
        }

        const newCheckId = wantsNewCheck ? [...wanted.keys()].at(-1)! : null;

        for (const order of locked.values()) {
          assertOrderOpen(order.status);

          if (order.orderType === "TAKEOUT" || order.tableSessionId !== source.tableSessionId) {
            throw new BusinessRuleError("DIFFERENT_SESSION", "Items can only be shared between checks at the same table.");
          }

          await assertNoOpenSettlement(transaction, order.id);
        }

        const [item] = await transaction
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, sourceOrderId)))
          .for("update");

        if (!item) {
          throw new NotFoundError("order item");
        }

        if (item.status !== "SUBMITTED") {
          throw new BusinessRuleError(
            "ITEM_NOT_SPLITTABLE",
            item.status === "DRAFT" ? "Send the item before sharing it." : "Only a sent item can be shared.",
          );
        }

        const [discounted] = await transaction
          .select({ id: orderItemDiscounts.id })
          .from(orderItemDiscounts)
          .where(and(eq(orderItemDiscounts.orderItemId, item.id), eq(orderItemDiscounts.status, "APPLIED")))
          .limit(1);

        if (discounted) {
          throw new BusinessRuleError("ITEM_DISCOUNTED", "Remove the item's discount before sharing it.");
        }

        const amounts = splitIntoShares(item.lineTotalSnapshot, input.shareCount);
        const splitGroupId = randomUUID();
        // The share rows first: the database lets a sent item become SPLIT only alongside them.
        const shares = await transaction
          .insert(orderItemShares)
          .values(
            input.targets.map((target, index) => ({
              organizationId: actor.organizationId,
              orderItemId: item.id,
              orderId: "newCheck" in target ? newCheckId! : target.orderId,
              splitGroupId,
              shareNumber: index + 1,
              shareCount: input.shareCount,
              amount: amounts[index]!,
              taxCategoryId: item.taxCategoryId,
              taxCategoryCodeSnapshot: item.taxCategoryCodeSnapshot,
              taxRateSnapshot: item.taxRateSnapshot,
              taxIncludedSnapshot: item.taxIncludedSnapshot,
              createdByUserId: actor.userId,
            })),
          )
          .returning();

        await transaction
          .update(orderItems)
          .set({ status: "SPLIT", updatedAt: new Date() })
          .where(eq(orderItems.id, item.id));

        const touched = [...new Set([sourceOrderId, ...shares.map((share) => share.orderId)])];
        const updated = [];

        for (const orderId of touched) {
          const row = await recomputeAndBumpOrder(transaction, orderId);

          updated.push({ orderId, orderNumber: row.orderNumber, version: row.version });
        }

        const at = new Date();

        await writeOutboxEvents(
          transaction,
          touched.map((orderId) => ({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            eventType: "order.item-split",
            aggregateType: "order",
            aggregateId: orderId,
            payload: { orderItemId: item.id, splitGroupId, fromOrderId: sourceOrderId },
            occurredAt: at,
          })),
        );
        await recordAudit(transaction, actor, {
          action: "orders.item-split",
          entityId: sourceOrderId,
          occurredAt: at,
          after: {
            orderItemId: item.id,
            fromOrderNumber: source.orderNumber,
            shareCount: input.shareCount,
            lineTotal: item.lineTotalSnapshot,
            toOrderNumbers: updated.filter((row) => row.orderId !== sourceOrderId).map((row) => row.orderNumber),
          },
        });

        return {
          orderItemId: item.id,
          splitGroupId,
          shares: shares.map((share) => ({
            shareId: share.id,
            shareNumber: share.shareNumber,
            orderId: share.orderId,
            amount: share.amount,
          })),
          orders: updated,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
