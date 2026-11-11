import { getTableName, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  cashDrawerMovements,
  cashDrawers,
  cashDrawerSessions,
  idempotencyRecords,
  orderRefundItems,
  orderRefunds,
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
  orderItemTransfers,
  orderStatusHistory,
  orderTaxLines,
  settlements,
  settlementStatusHistory,
  settlementTenders,
  timeEntries,
  timeEntryAdjustments,
  timeEntryBreaks,
  tipDistributionLines,
  tipDistributions,
  tipPoolRulePositions,
  tipPoolRules,
} from "@/db/schema";

const APPEND_ONLY = [
  "order_status_history",
  "order_item_status_history",
  "order_send_batches",
  "order_item_inventory_consumption",
  "order_item_voids",
  "order_item_transfers",
  "cash_drawer_movements",
  "order_refund_items",
  "kitchen_ticket_item_status_history",
  "kitchen_remakes",
  "kitchen_remake_consumption",
  "settlement_status_history",
  "time_entry_adjustments",
  "tip_distribution_lines",
];

/** Guard triggers that also refuse deletes, lifted with the append-only ones. */
const GUARDED: readonly [table: string, trigger: string][] = [
  ["kitchen_tickets", "kitchen_tickets_guard_trigger"],
  ["order_items", "order_items_freeze_trigger"],
  ["order_item_modifiers", "order_item_modifiers_freeze_trigger"],
  ["kitchen_ticket_items", "kitchen_ticket_items_guard_trigger"],
  ["notifications", "notifications_guard_trigger"],
  ["outbox_events", "outbox_events_guard_trigger"],
  ["order_settlements", "order_settlements_guard_trigger"],
  ["settlement_tenders", "settlement_tenders_guard_trigger"],
  ["order_refunds", "order_refunds_guard_trigger"],
  ["cash_drawer_sessions", "cash_drawer_sessions_guard_trigger"],
  ["time_entries", "time_entries_guard_trigger"],
  ["time_entry_breaks", "time_entry_breaks_guard_trigger"],
  ["tip_distributions", "tip_distributions_guard_trigger"],
];

/**
 * Test cleanup. Order, kitchen and settlement history is append-only and sent items are frozen, so this
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

    await transaction.delete(orderRefundItems);
    await transaction.delete(orderRefunds);
    await transaction.delete(settlementTenders);
    await transaction.delete(cashDrawerMovements);
    await transaction.delete(cashDrawerSessions);
    await transaction.delete(cashDrawers);
    await transaction.delete(settlementStatusHistory);
    await transaction.delete(settlements);

    const itemIds = transaction.select({ id: orderItems.id }).from(orderItems);

    await transaction.delete(orderItemTransfers);
    await transaction.delete(orderItemDiscounts);
    await transaction.delete(orderDiscounts);
    await transaction.delete(orderItemVoids);
    await transaction.delete(orderItemInventoryConsumption);
    await transaction.delete(orderItemStatusHistory);
    await transaction.delete(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, itemIds));
    await transaction.delete(orderItems);
    await transaction.delete(orderSendBatches);
    await transaction.delete(orderStatusHistory);
    await transaction.delete(orderTaxLines);
    await transaction.delete(orders);
    await transaction.delete(orderNumberCounters);
    // Phase 18: time entries and tip distributions reference idempotency records.
    await transaction.delete(tipDistributionLines);
    await transaction.delete(tipDistributions);
    await transaction.delete(tipPoolRulePositions);
    await transaction.delete(tipPoolRules);
    await transaction.delete(timeEntryAdjustments);
    await transaction.delete(timeEntryBreaks);
    await transaction.delete(timeEntries);
    await transaction.delete(idempotencyRecords);

    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}` as never);
    }
  });
}
