import { sql } from "drizzle-orm";

import type { DatabaseExecutor } from "../../src/db/transactions/transaction-context";

// Phase 19 rows that reference users, inventory items, ledger rows, supplier items and menu
// items with RESTRICT: low-stock alerts and their notifications, 86 records, sell-anyway
// overrides and preferred suppliers. Each E2E cleanup calls this for the rows it is about to
// delete. The guards are lifted for the caller's transaction only (test database only).

type Scope = {
  userIds?: readonly string[];
  inventoryItemIds?: readonly string[];
  supplierItemIds?: readonly string[];
  menuItemIds?: readonly string[];
};

const uuids = (ids: readonly string[] | undefined) =>
  sql`ARRAY[${sql.join(
    (ids ?? []).map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

export async function clearStockSignalRows(transaction: DatabaseExecutor, scope: Scope): Promise<void> {
  const users = uuids(scope.userIds);
  const items = uuids(scope.inventoryItemIds);
  const menuItems = uuids(scope.menuItemIds);
  const supplierItems = uuids(scope.supplierItemIds);
  const guards: [string, string][] = [
    ["notifications", "notifications_guard_trigger"],
    ["inventory_stock_alerts", "inventory_stock_alerts_guard"],
    ["menu_item_outages", "menu_item_outages_guard"],
    ["modifier_outages", "modifier_outages_guard"],
    ["menu_item_stock_overrides", "menu_item_stock_overrides_guard"],
  ];

  for (const [table, trigger] of guards) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  }

  // Alerts on these items, or opened or resolved by ledger rows these users posted.
  const alerts = sql`(
    SELECT a.id FROM inventory_stock_alerts a
    WHERE a.inventory_item_id = ANY(${items})
       OR a.opened_by_transaction_id IN (SELECT t.id FROM inventory_transactions t WHERE t.created_by_user_id = ANY(${users}) OR t.inventory_item_id = ANY(${items}))
       OR a.resolved_by_transaction_id IN (SELECT t.id FROM inventory_transactions t WHERE t.created_by_user_id = ANY(${users}) OR t.inventory_item_id = ANY(${items}))
  )`;

  await transaction.execute(
    sql`DELETE FROM notifications WHERE inventory_stock_alert_id IN ${alerts} OR (notification_type = 'INVENTORY_LOW' AND recipient_user_id = ANY(${users}))`,
  );
  await transaction.execute(sql`DELETE FROM inventory_stock_alerts WHERE id IN ${alerts}`);
  await transaction.execute(
    sql`DELETE FROM menu_item_outages WHERE menu_item_id = ANY(${menuItems}) OR marked_out_by_user_id = ANY(${users}) OR restored_by_user_id = ANY(${users})`,
  );
  await transaction.execute(
    sql`DELETE FROM modifier_outages WHERE marked_out_by_user_id = ANY(${users}) OR restored_by_user_id = ANY(${users})`,
  );
  await transaction.execute(
    sql`DELETE FROM menu_item_stock_overrides WHERE menu_item_id = ANY(${menuItems}) OR set_by_user_id = ANY(${users}) OR cleared_by_user_id = ANY(${users})`,
  );
  await transaction.execute(
    sql`UPDATE inventory_item_locations SET preferred_supplier_item_id = NULL WHERE preferred_supplier_item_id = ANY(${supplierItems})`,
  );

  for (const [table, trigger] of guards) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
  }
}
