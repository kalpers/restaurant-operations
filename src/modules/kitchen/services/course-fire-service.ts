import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import type { Database } from "@/db";
import { kitchenTicketItems, kitchenTickets, orderItems } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";
import { lockOrderRow } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";

import { assertKitchenPermission } from "./access";

// Phase 17 hold/fire (approved policies D22-D25). A held ticket keeps its items NEW and out
// of the station queues until its course is fired. Firing never touches inventory (it was
// consumed at SEND), the order's amount or its version, so it is allowed while a settlement
// is open. Firing a course with nothing held writes nothing.

/**
 * Held tickets carrying an order's work: its own tickets, and tickets whose items have since
 * moved to it (Phase 17 C19: station work follows the item).
 */
function heldTicketCondition(executor: DatabaseExecutor, orderId: string) {
  const movedIn = executor
    .selectDistinct({ id: kitchenTicketItems.ticketId })
    .from(kitchenTicketItems)
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .where(eq(orderItems.orderId, orderId));

  return and(isNull(kitchenTickets.firedAt), or(eq(kitchenTickets.orderId, orderId), inArray(kitchenTickets.id, movedIn)));
}

/** The courses an order has waiting to be fired, lowest first. Caller checks `orders.view`. */
export async function heldCoursesForOrder(executor: DatabaseExecutor, orderId: string): Promise<number[]> {
  const rows = await executor
    .selectDistinct({ course: kitchenTickets.courseNumber })
    .from(kitchenTickets)
    .where(heldTicketCondition(executor, orderId))
    .orderBy(asc(kitchenTickets.courseNumber));

  return rows.map((row) => row.course);
}

export type FireResult = { orderId: string; courseNumber: number; firedTicketIds: string[] };

/** Fires every held ticket of one course of an order, at once, in one transaction. */
export async function fireCourse(
  database: Database,
  actor: Actor,
  orderId: string,
  courseNumber: number,
): Promise<FireResult> {
  assertKitchenPermission(actor, "orders.fire");

  return withTransaction(database, async (transaction) => {
    // The order lock serializes firing with voids, which lock the order before its work.
    const order = await lockOrderRow(transaction, actor, orderId);

    assertOrderOpen(order.status);

    const held = await transaction
      .select({ id: kitchenTickets.id, prepStationId: kitchenTickets.prepStationId, orderId: kitchenTickets.orderId })
      .from(kitchenTickets)
      .where(
        and(
          eq(kitchenTickets.locationId, actor.locationId),
          eq(kitchenTickets.courseNumber, courseNumber),
          heldTicketCondition(transaction, orderId),
        ),
      )
      .orderBy(asc(kitchenTickets.id))
      .for("update");

    if (held.length === 0) {
      return { orderId, courseNumber, firedTicketIds: [] };
    }

    const at = new Date();

    await transaction
      .update(kitchenTickets)
      .set({ firedAt: at, firedByUserId: actor.userId })
      .where(inArray(kitchenTickets.id, held.map((ticket) => ticket.id)));
    await writeOutboxEvents(
      transaction,
      held.map((ticket) => ({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        eventType: "kitchen.course-fired",
        aggregateType: "kitchen_ticket",
        aggregateId: ticket.id,
        payload: { orderId, ticketOrderId: ticket.orderId, prepStationId: ticket.prepStationId, courseNumber },
        occurredAt: at,
      })),
    );

    return { orderId, courseNumber, firedTicketIds: held.map((ticket) => ticket.id) };
  });
}
