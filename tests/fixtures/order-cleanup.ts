import { inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  idempotencyRecords,
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
];

/**
 * Test cleanup. Order history is append-only and sent items are frozen, so this lifts
 * those triggers for its own transaction only, removes every order, and restores them.
 * Called before restaurant data is cleared, because orders reference table sessions.
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

    await transaction.execute("ALTER TABLE order_items DISABLE TRIGGER order_items_freeze_trigger" as never);
    await transaction.execute(
      "ALTER TABLE order_item_modifiers DISABLE TRIGGER order_item_modifiers_freeze_trigger" as never,
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

    await transaction.execute("ALTER TABLE order_items ENABLE TRIGGER order_items_freeze_trigger" as never);
    await transaction.execute(
      "ALTER TABLE order_item_modifiers ENABLE TRIGGER order_item_modifiers_freeze_trigger" as never,
    );
  });
}
