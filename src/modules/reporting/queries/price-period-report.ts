import { sql } from "drizzle-orm";

import { subtractDecimals } from "@/shared/decimal/decimal";

import type { ReportSection } from "../types";
import { rowsOf, SOLD_ITEM_STATUSES, soldLineTotal, type ReportContext } from "./report-context";

// Phase 28 (policy 5): what each price period sold and what it gave away, from the period
// snapshots frozen at SEND on items of CLOSED orders (the item-mix rule). Never reads current
// periods or prices, so changing or deactivating a period changes no past figure.

export async function pricePeriodsSection(context: ReportContext): Promise<ReportSection> {
  const { filters } = context;
  const rows = await rowsOf<{
    business_date: string;
    period: string;
    items: number;
    sales: string;
    regular: string;
  }>(
    context,
    sql`
      SELECT o.business_date::text AS business_date, oi.price_period_name_snapshot AS period,
             SUM(oi.quantity)::int AS items,
             SUM(${soldLineTotal})::numeric(14,2)::text AS sales,
             SUM((oi.regular_price_snapshot + oi.modifier_total_snapshot) * oi.quantity)::numeric(14,2)::text AS regular
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = ${filters.locationId}
        AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND o.status = 'CLOSED'
        ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
        AND oi.status IN ${SOLD_ITEM_STATUSES}
        AND oi.price_period_id IS NOT NULL
      GROUP BY o.business_date, oi.price_period_name_snapshot
      ORDER BY o.business_date, oi.price_period_name_snapshot
    `,
  );

  return {
    key: "pricePeriods",
    title: "Price periods",
    description:
      "Items sold at a price period (happy hour) price on CLOSED orders, from the price frozen at SEND. Regular value is the same items at the regular price then; the difference is what the period gave away, before discounts.",
    columns: [
      { key: "businessDate", label: "Business date", kind: "date" },
      { key: "period", label: "Price period", kind: "text" },
      { key: "items", label: "Items sold", kind: "count" },
      { key: "sales", label: "Sales at period price", kind: "money" },
      { key: "regular", label: "Regular value", kind: "money" },
      { key: "difference", label: "Difference", kind: "money" },
    ],
    rows: rows.map((row) => ({
      businessDate: row.business_date,
      period: row.period,
      items: row.items,
      sales: row.sales,
      regular: row.regular,
      difference: subtractDecimals(row.regular, row.sales),
    })),
  };
}
