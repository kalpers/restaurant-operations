import { sql } from "drizzle-orm";

import type { ReportColumn, ReportRow, ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

type SalesRow = {
  g_date: number;
  g_type: number;
  business_date: string | null;
  order_type: string | null;
  closed_orders: number;
  covers: number;
  gross_sales: string;
  discounts: string;
  comps: string;
  net_sales: string;
  average_check: string | null;
  open_checks: number;
  open_amount: string;
  voided_orders: number;
  voided_items: number;
  voided_amount: string;
};

const FIGURES: ReportColumn[] = [
  { key: "closedOrders", label: "Closed orders", kind: "count" },
  { key: "covers", label: "Covers", kind: "count" },
  { key: "grossSales", label: "Gross sales", kind: "money" },
  { key: "discounts", label: "Discounts", kind: "money" },
  { key: "comps", label: "Of which comps", kind: "money" },
  { key: "netSales", label: "Net sales", kind: "money" },
  { key: "averageCheck", label: "Average check", kind: "money" },
  { key: "openChecks", label: "Open checks", kind: "count" },
  { key: "openAmount", label: "Open check amount", kind: "money" },
  { key: "voidedOrders", label: "Voided orders", kind: "count" },
  { key: "voidedItems", label: "Voided items", kind: "count" },
  { key: "voidedAmount", label: "Voided item value", kind: "money" },
];

function figures(row: SalesRow): ReportRow {
  return {
    closedOrders: row.closed_orders,
    covers: row.covers,
    grossSales: row.gross_sales,
    discounts: row.discounts,
    comps: row.comps,
    netSales: row.net_sales,
    averageCheck: row.average_check,
    openChecks: row.open_checks,
    openAmount: row.open_amount,
    voidedOrders: row.voided_orders,
    voidedItems: row.voided_items,
    voidedAmount: row.voided_amount,
  };
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  DINE_IN: "Dine-in",
  BAR: "Bar",
  TAKEOUT: "Takeout",
};

/**
 * Sales by business date and order type (approved Phase 12 policy): net sales are CLOSED
 * orders only, from the stored order totals, which Phase 9 derives from submitted price
 * snapshots and applied-discount snapshots. Open checks and voids are separate figures.
 */
export async function salesSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const rows = await rowsOf<SalesRow>(
    context,
    sql`
      WITH scoped AS (
        SELECT o.id, o.business_date, o.order_type, o.status, o.item_subtotal, o.discount_total,
               o.subtotal, o.table_session_id, o.opened_at
        FROM orders o
        WHERE o.location_id = ${filters.locationId}
          AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
      ),
      comps AS (
        SELECT d.order_id, SUM(d.applied_amount) AS amount
        FROM (
          SELECT od.order_id, od.applied_amount, od.is_comp, od.status
          FROM order_discounts od JOIN scoped s ON s.id = od.order_id
          UNION ALL
          SELECT oi.order_id, oid.applied_amount, oid.is_comp, oid.status
          FROM order_item_discounts oid
          JOIN order_items oi ON oi.id = oid.order_item_id
          JOIN scoped s ON s.id = oi.order_id
        ) d
        WHERE d.is_comp AND d.status = 'APPLIED'
        GROUP BY d.order_id
      ),
      item_voids AS (
        SELECT oi.order_id, SUM(oi.quantity) AS quantity, SUM(oi.line_total_snapshot) AS amount
        FROM order_items oi JOIN scoped s ON s.id = oi.order_id
        WHERE oi.status = 'VOIDED' AND oi.submitted_at IS NOT NULL
        GROUP BY oi.order_id
      ),
      -- A session's covers count once, on its first closed order (split checks share a party).
      session_covers AS (
        SELECT s.id AS order_id,
               CASE WHEN ROW_NUMBER() OVER (PARTITION BY s.table_session_id ORDER BY s.opened_at, s.id) = 1
                    THEN ts.party_size ELSE 0 END AS covers
        FROM scoped s JOIN table_sessions ts ON ts.id = s.table_session_id
        WHERE s.status = 'CLOSED'
      ),
      per_order AS (
        SELECT s.*, COALESCE(c.amount, 0) AS comp_amount, COALESCE(v.quantity, 0) AS voided_quantity,
               COALESCE(v.amount, 0) AS voided_amount, COALESCE(sc.covers, 0) AS covers
        FROM scoped s
        LEFT JOIN comps c ON c.order_id = s.id
        LEFT JOIN item_voids v ON v.order_id = s.id
        LEFT JOIN session_covers sc ON sc.order_id = s.id
      )
      SELECT GROUPING(business_date)::int AS g_date,
             GROUPING(order_type)::int AS g_type,
             business_date::text AS business_date,
             order_type,
             (COUNT(*) FILTER (WHERE status = 'CLOSED'))::int AS closed_orders,
             (COALESCE(SUM(covers) FILTER (WHERE status = 'CLOSED'), 0))::int AS covers,
             COALESCE(SUM(item_subtotal) FILTER (WHERE status = 'CLOSED'), 0)::numeric(14,2)::text AS gross_sales,
             COALESCE(SUM(discount_total) FILTER (WHERE status = 'CLOSED'), 0)::numeric(14,2)::text AS discounts,
             COALESCE(SUM(comp_amount) FILTER (WHERE status = 'CLOSED'), 0)::numeric(14,2)::text AS comps,
             COALESCE(SUM(subtotal) FILTER (WHERE status = 'CLOSED'), 0)::numeric(14,2)::text AS net_sales,
             ROUND(SUM(subtotal) FILTER (WHERE status = 'CLOSED')
                   / NULLIF(COUNT(*) FILTER (WHERE status = 'CLOSED'), 0), 2)::text AS average_check,
             (COUNT(*) FILTER (WHERE status = 'OPEN'))::int AS open_checks,
             COALESCE(SUM(subtotal) FILTER (WHERE status = 'OPEN'), 0)::numeric(14,2)::text AS open_amount,
             (COUNT(*) FILTER (WHERE status = 'VOIDED'))::int AS voided_orders,
             COALESCE(SUM(voided_quantity), 0)::int AS voided_items,
             COALESCE(SUM(voided_amount), 0)::numeric(14,2)::text AS voided_amount
      FROM per_order
      GROUP BY GROUPING SETS ((business_date), (order_type), ())
      ORDER BY business_date NULLS LAST, order_type NULLS LAST
    `,
  );

  const total = rows.find((row) => row.g_date === 1 && row.g_type === 1);
  const byType = rows.filter((row) => row.g_date === 1 && row.g_type === 0);
  const byDate = rows.filter((row) => row.g_date === 0);

  return [
    {
      key: "summary",
      title: "Summary by order type",
      description: "Net sales count CLOSED orders only, before tax.",
      columns: [{ key: "orderType", label: "Order type", kind: "text" }, ...FIGURES],
      rows: [
        ...byType.map((row) => ({
          orderType: ORDER_TYPE_LABEL[row.order_type!] ?? row.order_type,
          ...figures(row),
        })),
        ...(total ? [{ orderType: "All", ...figures(total) }] : []),
      ],
    },
    {
      key: "daily",
      title: "By business date",
      columns: [{ key: "businessDate", label: "Business date", kind: "date" }, ...FIGURES],
      rows: byDate.map((row) => ({ businessDate: row.business_date, ...figures(row) })),
    },
  ];
}

/** Net sales of CLOSED orders in the range, for labor % and the dashboard. */
export async function netSalesTotal(context: ReportContext): Promise<string> {
  const [row] = await rowsOf<{ net: string }>(
    context,
    sql`
      SELECT COALESCE(SUM(subtotal), 0)::numeric(14,2)::text AS net
      FROM orders
      WHERE location_id = ${context.filters.locationId}
        AND business_date BETWEEN ${context.filters.from}::date AND ${context.filters.to}::date
        AND status = 'CLOSED'
    `,
  );

  return row?.net ?? "0.00";
}
