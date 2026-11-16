import { sql } from "drizzle-orm";

import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// Phase 25 policy 2 (D1): portions sold per menu item and business date, from CLOSED checks,
// counting items SUBMITTED or SPLIT (the item-mix rule), plus the modifiers chosen on them.
// Counts only, no money. Read-only.

export type ItemSalesHistory = {
  /** Business dates in the range with at least one closed check at the location. */
  openDates: string[];
  items: { businessDate: string; menuItemId: string; portions: number }[];
  /** Portions that carried each modifier, per item and date. */
  modifiers: { businessDate: string; menuItemId: string; modifierId: string; portions: number }[];
  /** Each item's first sale at the location (any date, closed checks only). */
  firstSaleDates: Map<string, string>;
};

export async function getItemSalesHistory(
  executor: DatabaseExecutor,
  input: { locationId: string; fromDate: string; toDate: string },
): Promise<ItemSalesHistory> {
  if (input.fromDate > input.toDate) {
    return { openDates: [], items: [], modifiers: [], firstSaleDates: new Map() };
  }

  const scope = sql`
    o.location_id = ${input.locationId}
    AND o.business_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date
    AND o.status = 'CLOSED'
  `;
  const [openRows, itemRows, modifierRows, firstRows] = await Promise.all([
    executor.execute(sql`
      SELECT DISTINCT o.business_date::text AS business_date
      FROM orders o WHERE ${scope}
      ORDER BY 1
    `),
    executor.execute(sql`
      SELECT o.business_date::text AS business_date, oi.menu_item_id, SUM(oi.quantity)::int AS portions
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${scope} AND oi.status IN ('SUBMITTED', 'SPLIT')
      GROUP BY o.business_date, oi.menu_item_id
      ORDER BY 1, 2
    `),
    executor.execute(sql`
      SELECT o.business_date::text AS business_date, oi.menu_item_id, m.modifier_id,
             SUM(oi.quantity)::int AS portions
      FROM order_item_modifiers m
      JOIN order_items oi ON oi.id = m.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE ${scope} AND oi.status IN ('SUBMITTED', 'SPLIT')
      GROUP BY o.business_date, oi.menu_item_id, m.modifier_id
      ORDER BY 1, 2, 3
    `),
    executor.execute(sql`
      SELECT oi.menu_item_id, MIN(o.business_date)::text AS first_date
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = ${input.locationId} AND o.status = 'CLOSED'
        AND oi.status IN ('SUBMITTED', 'SPLIT')
      GROUP BY oi.menu_item_id
    `),
  ]);

  return {
    openDates: (openRows as unknown as { business_date: string }[]).map((row) => row.business_date),
    items: (itemRows as unknown as { business_date: string; menu_item_id: string; portions: number }[]).map(
      (row) => ({ businessDate: row.business_date, menuItemId: row.menu_item_id, portions: row.portions }),
    ),
    modifiers: (
      modifierRows as unknown as { business_date: string; menu_item_id: string; modifier_id: string; portions: number }[]
    ).map((row) => ({
      businessDate: row.business_date,
      menuItemId: row.menu_item_id,
      modifierId: row.modifier_id,
      portions: row.portions,
    })),
    firstSaleDates: new Map(
      (firstRows as unknown as { menu_item_id: string; first_date: string }[]).map((row) => [
        row.menu_item_id,
        row.first_date,
      ]),
    ),
  };
}

/**
 * Phase 25 policy 8: portions already sent on a business date, on any check that isn't
 * voided (open or closed), counting items SUBMITTED or SPLIT.
 */
export async function getPortionsSentOn(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDate: string },
): Promise<Map<string, number>> {
  const rows = (await executor.execute(sql`
    SELECT oi.menu_item_id, SUM(oi.quantity)::int AS portions
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.location_id = ${input.locationId}
      AND o.business_date = ${input.businessDate}::date
      AND o.status <> 'VOIDED'
      AND oi.status IN ('SUBMITTED', 'SPLIT')
    GROUP BY oi.menu_item_id
  `)) as unknown as { menu_item_id: string; portions: number }[];

  return new Map(rows.map((row) => [row.menu_item_id, row.portions]));
}
