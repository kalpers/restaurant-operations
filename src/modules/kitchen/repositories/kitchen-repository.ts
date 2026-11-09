import { asc, eq, inArray } from "drizzle-orm";

import {
  employees,
  kitchenTicketItems,
  kitchenTicketItemStatusHistory,
  kitchenTickets,
  notifications,
  orders,
  orderSendBatches,
  users,
} from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents, type OutboxEventInput } from "@/infrastructure/outbox/outbox";

import { deriveTicketStatus } from "../rules/fulfillment-rules";
import type { KitchenItemStatus } from "../types";

export type TicketRow = typeof kitchenTickets.$inferSelect;
export type TicketItemRow = typeof kitchenTicketItems.$inferSelect;

export async function appendItemStatusHistory(
  transaction: DatabaseTransaction,
  rows: readonly {
    ticketItemId: string;
    status: KitchenItemStatus;
    reason?: string | null;
    userId: string | null;
    at: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await transaction.insert(kitchenTicketItemStatusHistory).values(
    rows.map((row) => ({
      ticketItemId: row.ticketItemId,
      status: row.status,
      reason: row.reason ?? null,
      changedByUserId: row.userId,
      occurredAt: row.at,
    })),
  );
}

/** A server's display name, from the general-tier employee name. */
export function displayName(first: string | null, last: string | null, preferred?: string | null) {
  if (!first) {
    return null;
  }

  return `${preferred ?? first} ${last ?? ""}`.trim();
}

/**
 * Who hears that a ticket is ready: the user linked to the order's server, if that user is
 * active, else whoever sent the batch.
 */
async function readyRecipient(executor: DatabaseExecutor, ticket: TicketRow): Promise<string> {
  const [row] = await executor
    .select({
      serverUserId: employees.userId,
      serverUserActive: users.active,
      sentByUserId: orderSendBatches.sentByUserId,
    })
    .from(orderSendBatches)
    .innerJoin(orders, eq(orders.id, orderSendBatches.orderId))
    .leftJoin(employees, eq(employees.id, orders.assignedServerEmployeeId))
    .leftJoin(users, eq(users.id, employees.userId))
    .where(eq(orderSendBatches.id, ticket.sendBatchId));

  return row!.serverUserId && row!.serverUserActive ? row!.serverUserId : row!.sentByUserId;
}

/**
 * After items on these tickets changed: any ticket whose derived status is now READY gets
 * its one server-ready notification (FOOD_READY or BAR_ORDER_READY), in the same
 * transaction, plus outbox events. A ticket notifies at most once (unique constraint).
 */
export async function notifyReadyTickets(
  transaction: DatabaseTransaction,
  ticketIds: readonly string[],
  at: Date,
): Promise<void> {
  const unique = [...new Set(ticketIds)];

  if (unique.length === 0) {
    return;
  }

  const tickets = await transaction.select().from(kitchenTickets).where(inArray(kitchenTickets.id, unique));
  const items = await transaction
    .select({
      ticketId: kitchenTicketItems.ticketId,
      status: kitchenTicketItems.status,
      quantity: kitchenTicketItems.quantity,
      name: kitchenTicketItems.menuItemNameSnapshot,
    })
    .from(kitchenTicketItems)
    .where(inArray(kitchenTicketItems.ticketId, unique))
    .orderBy(asc(kitchenTicketItems.id));
  const events: OutboxEventInput[] = [];

  for (const ticket of tickets) {
    const own = items.filter((item) => item.ticketId === ticket.id);

    if (deriveTicketStatus(own.map((item) => item.status as KitchenItemStatus)) !== "READY") {
      continue;
    }

    const type = ticket.stationTypeSnapshot === "BAR" ? "BAR_ORDER_READY" : "FOOD_READY";
    const where = ticket.tableLabelSnapshot ?? (ticket.orderTypeSnapshot === "TAKEOUT" ? "Takeout" : "Bar");
    const what = own
      .filter((item) => item.status === "READY" || item.status === "COMPLETED")
      .map((item) => `${item.quantity}× ${item.name}`)
      .join(", ");
    const recipientUserId = await readyRecipient(transaction, ticket);
    const [created] = await transaction
      .insert(notifications)
      .values({
        organizationId: ticket.organizationId,
        locationId: ticket.locationId,
        recipientUserId,
        notificationType: type,
        title: `${type === "BAR_ORDER_READY" ? "Drinks" : "Food"} ready: order #${ticket.orderNumberSnapshot}`,
        body: `${where} · ${ticket.stationNameSnapshot}: ${what}`,
        orderId: ticket.orderId,
        kitchenTicketId: ticket.id,
        createdAt: at,
      })
      .onConflictDoNothing({ target: [notifications.kitchenTicketId, notifications.notificationType] })
      .returning({ id: notifications.id });

    events.push({
      organizationId: ticket.organizationId,
      locationId: ticket.locationId,
      eventType: "kitchen.ticket-ready",
      aggregateType: "kitchen_ticket",
      aggregateId: ticket.id,
      payload: { orderId: ticket.orderId, prepStationId: ticket.prepStationId },
      occurredAt: at,
    });

    if (created) {
      events.push({
        organizationId: ticket.organizationId,
        locationId: ticket.locationId,
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: created.id,
        recipientUserId,
        payload: { notificationType: type, orderId: ticket.orderId },
        occurredAt: at,
      });
    }
  }

  await writeOutboxEvents(transaction, events);
}

/** Every station item of an Order Item, across all attempts, locked for update in ID order. */
export async function lockItemsForOrderItem(transaction: DatabaseTransaction, orderItemId: string) {
  return transaction
    .select()
    .from(kitchenTicketItems)
    .where(eq(kitchenTicketItems.orderItemId, orderItemId))
    .orderBy(asc(kitchenTicketItems.id))
    .for("update");
}

export async function ticketsByIds(executor: DatabaseExecutor, ids: readonly string[]) {
  if (ids.length === 0) {
    return [];
  }

  return executor.select().from(kitchenTickets).where(inArray(kitchenTickets.id, [...ids]));
}

export function itemStatusEvent(
  ticket: Pick<TicketRow, "organizationId" | "locationId" | "orderId" | "prepStationId">,
  item: { id: string; ticketId: string; orderItemId: string },
  status: KitchenItemStatus,
  at: Date,
): OutboxEventInput {
  return {
    organizationId: ticket.organizationId,
    locationId: ticket.locationId,
    eventType: status === "READY" ? "kitchen.item-ready" : "kitchen.item-status-changed",
    aggregateType: "kitchen_ticket_item",
    aggregateId: item.id,
    payload: {
      ticketId: item.ticketId,
      orderId: ticket.orderId,
      orderItemId: item.orderItemId,
      prepStationId: ticket.prepStationId,
      status,
    },
    occurredAt: at,
  };
}
