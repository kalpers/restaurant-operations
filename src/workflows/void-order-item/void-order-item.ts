import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  orderItemDiscounts,
  orderItemInventoryConsumption,
  orderItems,
  orderItemVoids,
} from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { postSaleReversal } from "@/modules/inventory/services/order-consumption";
import { cancelFulfillmentForVoid } from "@/modules/kitchen/services/void-sync";
import {
  appendItemHistory,
  appendOrderHistory,
  lockOrder,
  recomputeAndBumpOrder,
} from "@/modules/orders/repositories/order-repository";
import { assertItemVoidable, assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { assertPermission } from "@/modules/orders/services/access";
import type { VoidDisposition } from "@/modules/orders/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

// Voids of sent items. The row stays, marked VOIDED with who, when, why and the physical
// disposition. Its station work is synchronized first (Phase 10): UNPREPARED is allowed only
// while every station item of every attempt is still NEW, and cancels them all;
// PREPARED_OR_DISCARDED cancels NEW/PREPARING/READY and keeps COMPLETED history. UNPREPARED
// restores stock with SALE_REVERSAL rows linked to each original CONSUME and each Remake
// CONSUME; PREPARED_OR_DISCARDED keeps all consumption and records no waste (staff use the
// Inventory waste workflow if they want to). Any refusal rolls the whole void back.

function requireReason(reason: string): string {
  const trimmed = reason.trim();

  if (!trimmed) {
    throw new BusinessRuleError("REASON_REQUIRED", "Enter a reason for the void.");
  }

  return trimmed;
}

async function voidSubmittedItem(
  transaction: DatabaseTransaction,
  actor: Actor,
  item: { id: string; status: string },
  input: { reason: string; disposition: VoidDisposition; at: Date },
) {
  assertItemVoidable(item.status);

  const [voidRow] = await transaction
    .insert(orderItemVoids)
    .values({
      orderItemId: item.id,
      disposition: input.disposition,
      reason: input.reason,
      voidedByUserId: actor.userId,
      voidedAt: input.at,
    })
    .returning({ id: orderItemVoids.id });

  const fulfillment = await cancelFulfillmentForVoid(transaction, {
    orderItemId: item.id,
    disposition: input.disposition,
    reason: input.reason,
    actorUserId: actor.userId,
    at: input.at,
  });

  if (input.disposition === "UNPREPARED") {
    const consumed = await transaction
      .select({ transactionId: orderItemInventoryConsumption.inventoryTransactionId })
      .from(orderItemInventoryConsumption)
      .where(eq(orderItemInventoryConsumption.orderItemId, item.id));

    await postSaleReversal(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      originalTransactionIds: [
        ...consumed.map((row) => row.transactionId),
        ...fulfillment.remakeTransactionIds,
      ],
      voidId: voidRow!.id,
      occurredAt: input.at,
      createdByUserId: actor.userId,
    });
  }

  await markVoided(transaction, actor, [item.id], input.reason, input.at);
  await appendItemHistory(transaction, [
    {
      orderItemId: item.id,
      status: "VOIDED",
      reason: `${input.disposition}: ${input.reason}`,
      userId: actor.userId,
      at: input.at,
    },
  ]);
}

async function markVoided(
  transaction: DatabaseTransaction,
  actor: Actor,
  itemIds: string[],
  reason: string,
  at: Date,
) {
  if (itemIds.length === 0) {
    return;
  }

  await transaction
    .update(orderItems)
    .set({
      status: "VOIDED",
      voidedAt: at,
      voidedByUserId: actor.userId,
      voidReason: reason,
      version: sql`${orderItems.version} + 1`,
      updatedAt: at,
    })
    .where(inArray(orderItems.id, itemIds));
  // A voided item has nothing left to discount.
  await transaction
    .update(orderItemDiscounts)
    .set({ status: "VOIDED", updatedAt: at })
    .where(and(inArray(orderItemDiscounts.orderItemId, itemIds), eq(orderItemDiscounts.status, "APPLIED")));
}

export async function voidOrderItem(
  database: Database,
  actor: Actor,
  orderId: string,
  itemId: string,
  input: { reason: string; disposition: VoidDisposition; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "orders.void");

  const reason = requireReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);
    await assertNoOpenSettlement(transaction, order.id);

    const [item] = await transaction
      .select({ id: orderItems.id, status: orderItems.status })
      .from(orderItems)
      .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("order item");
    }

    const at = new Date();

    await voidSubmittedItem(transaction, actor, item, {
      reason,
      disposition: input.disposition,
      at,
    });

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    await recordAudit(transaction, actor, {
      action: "orders.item-voided",
      entityId: orderId,
      occurredAt: at,
      before: { orderItemId: item.id, status: item.status },
      after: { orderItemId: item.id, status: "VOIDED", disposition: input.disposition, reason },
    });

    return { id: orderId, version: updated.version };
  });
}

/**
 * Voids a whole order in one transaction: each sent item with its own disposition, every
 * draft with no stock movement, then the order itself. Nothing is deleted.
 */
export async function voidOrder(
  database: Database,
  actor: Actor,
  orderId: string,
  input: {
    reason: string;
    expectedVersion: number;
    dispositions: Record<string, VoidDisposition>;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "orders.void");

  const reason = requireReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const at = new Date();
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);
    await assertNoOpenSettlement(transaction, order.id);

    const items = await transaction
      .select({ id: orderItems.id, status: orderItems.status })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.id)
      .for("update");
    const submitted = items.filter((item) => item.status === "SUBMITTED");
    const missing = submitted.filter((item) => !input.dispositions[item.id]);

    if (missing.length > 0) {
      throw new BusinessRuleError(
        "DISPOSITION_REQUIRED",
        "Choose whether each sent item was prepared before voiding the order.",
      );
    }

    for (const item of submitted) {
      await voidSubmittedItem(transaction, actor, item, {
        reason,
        disposition: input.dispositions[item.id]!,
        at,
      });
    }

    await markVoided(
      transaction,
      actor,
      items.filter((item) => item.status === "DRAFT").map((item) => item.id),
      reason,
      at,
    );

    const updated = await recomputeAndBumpOrder(transaction, orderId, {
      status: "VOIDED",
      voidedAt: at,
      voidedByUserId: actor.userId,
      voidReason: reason,
    });

    await appendOrderHistory(transaction, {
      orderId,
      status: "VOIDED",
      reason,
      userId: actor.userId,
      at,
    });
    await recordAudit(transaction, actor, {
      action: "orders.order-voided",
      entityId: orderId,
      occurredAt: at,
      before: { status: order.status },
      after: { status: "VOIDED", reason, voidedItemCount: items.length },
    });

    return { id: orderId, version: updated.version };
  });
}
