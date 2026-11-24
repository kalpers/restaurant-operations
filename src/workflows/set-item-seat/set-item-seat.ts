import { and, eq, ne, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItems } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";
import { lockOrder, recomputeAndBumpOrder } from "@/modules/orders/repositories/order-repository";
import { assertNotBundleComponent } from "@/modules/orders/rules/bundle-lines";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { assertSeatAllowed, validateSeat } from "@/modules/orders/rules/seats";
import { assertPermission } from "@/modules/orders/services/access";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

/**
 * Phase 29 (policies 5, 6): sets or clears an item's seat, draft or sent, while the check is
 * OPEN with no OPEN settlement. The seat isn't a snapshot: it changes no price, stock, tax,
 * ticket or timing, so the freeze trigger lets it through. Not audited; a change to a sent
 * item emits `order.item-seat-changed` after commit so Expo and the order screen refresh.
 */
export async function setItemSeat(
  database: Database,
  actor: Actor,
  orderId: string,
  itemId: string,
  input: { expectedVersion: number; seatNumber: number | null },
): Promise<{ id: string; version: number; seatNumber: number | null }> {
  assertPermission(actor, "orders.edit");

  const seatNumber = validateSeat(input.seatNumber);

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);
    assertSeatAllowed(order);
    // A seat moves no money, so the order guard trigger wouldn't stop it while a settlement
    // is OPEN; Settlements is asked here, in the workflow, as the move workflow does.
    await assertNoOpenSettlement(transaction, order.id);

    const [item] = await transaction
      .select({
        id: orderItems.id,
        status: orderItems.status,
        seatNumber: orderItems.seatNumber,
        bundleParentOrderItemId: orderItems.bundleParentOrderItemId,
      })
      .from(orderItems)
      .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("order item");
    }

    if (item.status === "VOIDED") {
      throw new BusinessRuleError("ITEM_VOIDED", "A voided item can't change seat.");
    }

    // Phase 36 (policy 9): a bundle changes seat with its components; a component alone doesn't.
    assertNotBundleComponent(item, "change the seat of");

    if (item.seatNumber === seatNumber) {
      return { id: order.id, version: order.version, seatNumber };
    }

    await transaction
      .update(orderItems)
      .set({ seatNumber, version: sql`${orderItems.version} + 1`, updatedAt: new Date() })
      .where(eq(orderItems.id, itemId));
    await transaction
      .update(orderItems)
      .set({ seatNumber, version: sql`${orderItems.version} + 1`, updatedAt: new Date() })
      .where(and(eq(orderItems.bundleParentOrderItemId, itemId), ne(orderItems.status, "VOIDED")));

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    if (item.status !== "DRAFT") {
      await writeOutboxEvents(transaction, [
        {
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          eventType: "order.item-seat-changed",
          aggregateType: "order",
          aggregateId: order.id,
          payload: { orderId: order.id, orderItemId: itemId, seatNumber },
          occurredAt: new Date(),
        },
      ]);
    }

    return { id: order.id, version: updated.version, seatNumber };
  });
}
