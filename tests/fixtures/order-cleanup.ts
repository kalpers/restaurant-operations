import { getTableName, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  idempotencyRecords,
  kitchenRemakeConsumption,
  kitchenRemakes,
  kitchenTicketItems,
  kitchenTicketItemStatusHistory,
  kitchenTickets,
  notifications,
  outboxEvents,
  orderDiscounts,
  orderItemDiscounts,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItems,
  orderItemStatusHistory,
  orderItemVoids,
  orderNumberCounters,
  orders,
  orderSendBatches,
  orderStatusHistory,
} from "@/db/schema";

const APPEND_ONLY = [
  "order_status_history",
  "order_item_status_history",
  "order_send_batches",
  "order_item_inventory_consumption",
  "order_item_voids",
  "kitchen_tickets",
  "kitchen_ticket_item_status_history",
  "kitchen_remakes",
  "kitchen_remake_consumption",
];

/** Guard triggers that also refuse deletes, lifted with the append-only ones. */
const GUARDED: readonly [table: string, trigger: string][] = [
  ["order_items", "order_items_freeze_trigger"],
  ["order_item_modifiers", "order_item_modifiers_freeze_trigger"],
  ["kitchen_ticket_items", "kitchen_ticket_items_guard_trigger"],
  ["notifications", "notifications_guard_trigger"],
  ["outbox_events", "outbox_events_guard_trigger"],
];

/**
 * Test cleanup. Order and kitchen history is append-only and sent items are frozen, so this
 * lifts those triggers for its own transaction only, removes every order with its kitchen
 * work, notifications and outbox events, and restores them. Called before restaurant data
 * is cleared, because orders reference table sessions.
 */
export async function clearOrderData(database: Database): Promise<void> {
  const [any] = await database.select({ id: orders.id }).from(orders).limit(1);
  const [anyKey] = await database.select({ id: idempotencyRecords.id }).from(idempotencyRecords).limit(1);

  if (!any && !anyKey) {
    return;
  }

  await database.transaction(async (transaction) => {
    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}` as never);
    }

    // Tickets, Remakes and ticket items reference each other, so one TRUNCATE removes them
    // together (test database only; integration files run one at a time).
    await transaction.execute(
      `TRUNCATE ${[
        notifications,
        outboxEvents,
        kitchenRemakeConsumption,
        kitchenTicketItemStatusHistory,
        kitchenTicketItems,
        kitchenTickets,
        kitchenRemakes,
      ]
        .map((table) => getTableName(table))
        .join(", ")}` as never,
    );

    const itemIds = transaction.select({ id: orderItems.id }).from(orderItems);

    await transaction.delete(orderItemDiscounts);
    await transaction.delete(orderDiscounts);
    await transaction.delete(orderItemVoids);
    await transaction.delete(orderItemInventoryConsumption);
    await transaction.delete(orderItemStatusHistory);
    await transaction.delete(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, itemIds));
    await transaction.delete(orderItems);
    await transaction.delete(orderSendBatches);
    await transaction.delete(orderStatusHistory);
    await transaction.delete(orders);
    await transaction.delete(orderNumberCounters);
    await transaction.delete(idempotencyRecords);

    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}` as never);
    }
  });
}
