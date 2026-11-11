import { inArray, or } from "drizzle-orm";

import { orderItemTransfers, orderRefundItems, orderRefunds, orderTaxLines } from "../../src/db/schema";
import type { DatabaseTransaction } from "../../src/db/transactions/transaction-context";

/**
 * Phase 17 rows that hang off orders, removed by the E2E cleanups before their order items
 * and orders (each references them with ON DELETE RESTRICT).
 */
export async function deleteOrderExtras(transaction: DatabaseTransaction, orderIds: readonly string[]) {
  if (orderIds.length === 0) {
    return;
  }

  await transaction.delete(orderTaxLines).where(inArray(orderTaxLines.orderId, [...orderIds]));

  // Refunds and their item links are guarded; lift those triggers for this transaction only.
  await transaction.execute("ALTER TABLE order_refund_items DISABLE TRIGGER order_refund_items_append_only_trigger" as never);
  await transaction.execute("ALTER TABLE order_refunds DISABLE TRIGGER order_refunds_guard_trigger" as never);
  const refundIds = transaction
    .select({ id: orderRefunds.id })
    .from(orderRefunds)
    .where(inArray(orderRefunds.orderId, [...orderIds]));

  await transaction.delete(orderRefundItems).where(inArray(orderRefundItems.refundId, refundIds));
  await transaction.delete(orderRefunds).where(inArray(orderRefunds.orderId, [...orderIds]));
  await transaction.execute("ALTER TABLE order_refunds ENABLE TRIGGER order_refunds_guard_trigger" as never);
  await transaction.execute("ALTER TABLE order_refund_items ENABLE TRIGGER order_refund_items_append_only_trigger" as never);

  // Transfers are append-only; lift that trigger for this transaction only.
  await transaction.execute("ALTER TABLE order_item_transfers DISABLE TRIGGER order_item_transfers_append_only_trigger" as never);
  await transaction
    .delete(orderItemTransfers)
    .where(or(inArray(orderItemTransfers.fromOrderId, [...orderIds]), inArray(orderItemTransfers.toOrderId, [...orderIds])));
  await transaction.execute("ALTER TABLE order_item_transfers ENABLE TRIGGER order_item_transfers_append_only_trigger" as never);
}
