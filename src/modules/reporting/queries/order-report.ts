import { sql } from "drizzle-orm";

import type { ReportSection } from "../types";

import { minutes, rowsOf, type ReportContext } from "./report-context";

const DISPOSITION_LABEL: Record<string, string> = {
  UNPREPARED: "Unprepared (stock returned)",
  PREPARED_OR_DISCARDED: "Prepared or discarded",
};

/**
 * Order analytics by `orders.business_date`: lifecycle counts, check speed, voids, discounts
 * and per-server results. The employee filter selects the assigned server.
 */
export async function orderSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const scope = sql`
    o.location_id = ${filters.locationId}
    AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
    ${filters.employeeId ? sql`AND o.assigned_server_employee_id = ${filters.employeeId}` : sql``}
  `;

  const lifecycle = await rowsOf<{
    order_type: string | null;
    total: number;
    open: number;
    closed: number;
    voided: number;
    items_per_order: string | null;
    open_to_close: string | null;
  }>(
    context,
    sql`
      WITH scoped AS (
        SELECT o.id, o.order_type, o.status, o.opened_at, o.closed_at,
               (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                 WHERE oi.order_id = o.id AND oi.status = 'SUBMITTED') AS items
        FROM orders o WHERE ${scope}
      )
      SELECT order_type,
             COUNT(*)::int AS total,
             (COUNT(*) FILTER (WHERE status = 'OPEN'))::int AS open,
             (COUNT(*) FILTER (WHERE status = 'CLOSED'))::int AS closed,
             (COUNT(*) FILTER (WHERE status = 'VOIDED'))::int AS voided,
             ROUND(AVG(items) FILTER (WHERE status = 'CLOSED'), 2)::text AS items_per_order,
             (AVG(EXTRACT(EPOCH FROM closed_at - opened_at) / 60) FILTER (WHERE status = 'CLOSED'))::text AS open_to_close
      FROM scoped
      GROUP BY GROUPING SETS ((order_type), ())
      ORDER BY order_type NULLS LAST
    `,
  );

  const servers = await rowsOf<{
    employee_number: string | null;
    server_name: string | null;
    closed: number;
    covers: number;
    net_sales: string;
    average_check: string | null;
  }>(
    context,
    sql`
      WITH closed AS (
        SELECT o.id, o.assigned_server_employee_id, o.subtotal, o.table_session_id, o.opened_at
        FROM orders o WHERE ${scope} AND o.status = 'CLOSED'
      ),
      covers AS (
        SELECT c.id,
               CASE WHEN ROW_NUMBER() OVER (PARTITION BY c.table_session_id ORDER BY c.opened_at, c.id) = 1
                    THEN ts.party_size ELSE 0 END AS covers
        FROM closed c JOIN table_sessions ts ON ts.id = c.table_session_id
      )
      SELECT e.employee_number,
             CASE WHEN e.id IS NULL THEN NULL
                  ELSE COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name END AS server_name,
             COUNT(*)::int AS closed,
             COALESCE(SUM(cv.covers), 0)::int AS covers,
             SUM(c.subtotal)::numeric(14,2)::text AS net_sales,
             ROUND(SUM(c.subtotal) / COUNT(*), 2)::text AS average_check
      FROM closed c
      LEFT JOIN covers cv ON cv.id = c.id
      LEFT JOIN employees e ON e.id = c.assigned_server_employee_id
      GROUP BY e.id, e.employee_number, e.preferred_name, e.first_name, e.last_name
      ORDER BY SUM(c.subtotal) DESC, e.employee_number NULLS LAST
    `,
  );

  const voids = await rowsOf<{ disposition: string; reason: string; items: number; quantity: number; amount: string }>(
    context,
    sql`
      SELECT v.disposition, v.reason, COUNT(*)::int AS items, SUM(oi.quantity)::int AS quantity,
             SUM(oi.line_total_snapshot)::numeric(14,2)::text AS amount
      FROM order_item_voids v
      JOIN order_items oi ON oi.id = v.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE ${scope}
      GROUP BY v.disposition, v.reason
      ORDER BY SUM(oi.line_total_snapshot) DESC, v.disposition, v.reason
    `,
  );

  const discounts = await rowsOf<{
    code: string;
    name: string;
    scope: string;
    applications: number;
    comps: number;
    amount: string;
  }>(
    context,
    sql`
      WITH applied AS (
        SELECT d.code_snapshot, d.name_snapshot, 'Order' AS scope, d.is_comp, d.applied_amount
        FROM order_discounts d JOIN orders o ON o.id = d.order_id
        WHERE ${scope} AND o.status <> 'VOIDED' AND d.status = 'APPLIED'
        UNION ALL
        SELECT d.code_snapshot, d.name_snapshot, 'Item', d.is_comp, d.applied_amount
        FROM order_item_discounts d
        JOIN order_items oi ON oi.id = d.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE ${scope} AND o.status <> 'VOIDED' AND d.status = 'APPLIED'
      )
      SELECT code_snapshot AS code, name_snapshot AS name, scope,
             COUNT(*)::int AS applications,
             (COUNT(*) FILTER (WHERE is_comp))::int AS comps,
             SUM(applied_amount)::numeric(14,2)::text AS amount
      FROM applied
      GROUP BY code_snapshot, name_snapshot, scope
      ORDER BY SUM(applied_amount) DESC, code
    `,
  );

  return [
    {
      key: "lifecycle",
      title: "Orders by type",
      columns: [
        { key: "orderType", label: "Order type", kind: "text" },
        { key: "total", label: "Orders", kind: "count" },
        { key: "open", label: "Open", kind: "count" },
        { key: "closed", label: "Closed", kind: "count" },
        { key: "voided", label: "Voided", kind: "count" },
        { key: "itemsPerOrder", label: "Items per closed order", kind: "quantity" },
        { key: "openToClose", label: "Average minutes open to close", kind: "minutes" },
      ],
      rows: lifecycle.map((row) => ({
        orderType: row.order_type ?? "All",
        total: row.total,
        open: row.open,
        closed: row.closed,
        voided: row.voided,
        itemsPerOrder: row.items_per_order,
        openToClose: minutes(row.open_to_close),
      })),
    },
    {
      key: "servers",
      title: "Closed orders by server",
      columns: [
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "server", label: "Server", kind: "text" },
        { key: "closed", label: "Closed orders", kind: "count" },
        { key: "covers", label: "Covers", kind: "count" },
        { key: "netSales", label: "Net sales", kind: "money" },
        { key: "averageCheck", label: "Average check", kind: "money" },
      ],
      rows: servers.map((row) => ({
        employeeNumber: row.employee_number,
        server: row.server_name ?? "Unassigned",
        closed: row.closed,
        covers: row.covers,
        netSales: row.net_sales,
        averageCheck: row.average_check,
      })),
    },
    {
      key: "voids",
      title: "Item voids",
      description: "Sent items that were voided, valued at their snapshotted line totals.",
      columns: [
        { key: "disposition", label: "Disposition", kind: "text" },
        { key: "reason", label: "Reason", kind: "text" },
        { key: "items", label: "Voided lines", kind: "count" },
        { key: "quantity", label: "Quantity", kind: "count" },
        { key: "amount", label: "Value", kind: "money" },
      ],
      rows: voids.map((row) => ({
        disposition: DISPOSITION_LABEL[row.disposition] ?? row.disposition,
        reason: row.reason,
        items: row.items,
        quantity: row.quantity,
        amount: row.amount,
      })),
    },
    {
      key: "discounts",
      title: "Discounts and comps",
      description: "Applied discounts on orders that were not voided, by the definition snapshotted when applied.",
      columns: [
        { key: "code", label: "Code", kind: "text" },
        { key: "name", label: "Discount", kind: "text" },
        { key: "scope", label: "Applies to", kind: "text" },
        { key: "applications", label: "Times applied", kind: "count" },
        { key: "comps", label: "Comps", kind: "count" },
        { key: "amount", label: "Amount", kind: "money" },
      ],
      rows: discounts.map((row) => ({
        code: row.code,
        name: row.name,
        scope: row.scope,
        applications: row.applications,
        comps: row.comps,
        amount: row.amount,
      })),
    },
  ];
}
