import { sql } from "drizzle-orm";

import { divideRoundHalfUp } from "@/shared/decimal/decimal";

import { hourLabel, hoursFromCutoff } from "../rules/hour-buckets";
import { classifyMenuItems, ENGINEERING_LABEL } from "../rules/menu-engineering";
import type { ReportColumn, ReportSection } from "../types";

import { minutes, rowsOf, SOLD_ITEM_STATUSES, soldLineTotal, type ReportContext } from "./report-context";

// Phase 19 report sections (policies 19-24), added to the existing Sales, Menu, Orders and
// Inventory areas under their existing permissions. Everything reads CLOSED-order snapshots,
// tender rows and 86 records; nothing is recomputed from current menu or cost configuration.

const closedScope = (context: ReportContext) => {
  const { filters } = context;

  return sql`
    o.location_id = ${filters.locationId}
    AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    AND o.status = 'CLOSED'
    ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
  `;
};

// ------------------------------------------------------------------ sales by hour

/** Policy 19 (D9): CLOSED orders by the local hour they were opened, every hour shown. */
export async function salesByHourSection(context: ReportContext): Promise<ReportSection> {
  const rows = await rowsOf<{
    hour: number;
    closed: number;
    covers: number;
    net_sales: string;
  }>(
    context,
    sql`
      WITH closed AS (
        SELECT o.id, o.subtotal, o.table_session_id, o.opened_at,
               EXTRACT(HOUR FROM o.opened_at AT TIME ZONE ${context.settings.timeZone})::int AS hour
        FROM orders o WHERE ${closedScope(context)}
      ),
      covers AS (
        SELECT c.id,
               CASE WHEN ROW_NUMBER() OVER (PARTITION BY c.table_session_id ORDER BY c.opened_at, c.id) = 1
                    THEN ts.party_size ELSE 0 END AS covers
        FROM closed c JOIN table_sessions ts ON ts.id = c.table_session_id
      )
      SELECT c.hour, COUNT(*)::int AS closed, COALESCE(SUM(cv.covers), 0)::int AS covers,
             SUM(c.subtotal)::numeric(14,2)::text AS net_sales
      FROM closed c LEFT JOIN covers cv ON cv.id = c.id
      GROUP BY c.hour
    `,
  );
  const byHour = new Map(rows.map((row) => [row.hour, row]));

  return {
    key: "salesByHour",
    title: "Sales by hour",
    description:
      "CLOSED orders by the local hour they were opened, from the business-day cutoff. Covers count once per table session.",
    columns: [
      { key: "hour", label: "Hour opened", kind: "text" },
      { key: "closedOrders", label: "Closed orders", kind: "count" },
      { key: "covers", label: "Covers", kind: "count" },
      { key: "netSales", label: "Net sales", kind: "money" },
      { key: "averageCheck", label: "Average check", kind: "money" },
    ],
    rows: hoursFromCutoff(context.settings.businessDayCutoff).map((hour) => {
      const row = byHour.get(hour);

      return {
        hour: hourLabel(hour),
        closedOrders: row?.closed ?? 0,
        covers: row?.covers ?? 0,
        netSales: row?.net_sales ?? "0.00",
        averageCheck: row && row.closed > 0 ? divideRoundHalfUp(row.net_sales, String(row.closed), 2) : null,
      };
    }),
  };
}

// ------------------------------------------------------------------ item mix and engineering

type MixRow = {
  code: string;
  name: string;
  quantity: number;
  net_sales: string;
  quantity_percent: string | null;
  sales_percent: string | null;
  cost: string | null;
  margin: string | null;
};

/** Policies 20-21 (amendment 7: across the whole menu, no category grouping). */
export async function itemMixSections(context: ReportContext): Promise<ReportSection[]> {
  const rows = await rowsOf<MixRow>(
    context,
    sql`
      WITH lines AS (
        SELECT oi.menu_item_code_snapshot AS code, oi.menu_item_name_snapshot AS name, oi.quantity,
               ${soldLineTotal}
                 - COALESCE((SELECT SUM(d.applied_amount) FROM order_item_discounts d
                              WHERE d.order_item_id = oi.id AND d.status = 'APPLIED'), 0) AS net,
               (SELECT SUM(t.total_cost) FROM order_item_inventory_consumption c
                  JOIN inventory_transactions t ON t.id = c.inventory_transaction_id
                 WHERE c.order_item_id = oi.id) AS cost,
               EXISTS (SELECT 1 FROM order_item_inventory_consumption c WHERE c.order_item_id = oi.id) AS has_consumption
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${closedScope(context)} AND oi.status IN ${SOLD_ITEM_STATUSES}
      ),
      grouped AS (
        SELECT code, name, SUM(quantity)::int AS quantity, SUM(net) AS net,
               CASE WHEN bool_and(has_consumption) THEN SUM(cost) END AS cost
        FROM lines GROUP BY code, name
      )
      SELECT code, name, quantity,
             net::numeric(14,2)::text AS net_sales,
             ROUND(quantity * 100.0 / NULLIF(SUM(quantity) OVER (), 0), 2)::text AS quantity_percent,
             ROUND(net * 100 / NULLIF(SUM(net) OVER (), 0), 2)::text AS sales_percent,
             cost::numeric(14,4)::text AS cost,
             CASE WHEN cost IS NULL THEN NULL ELSE ROUND(net - cost, 2)::text END AS margin
      FROM grouped
      ORDER BY quantity DESC, code, name
    `,
  );
  const mix: ReportSection = {
    key: "itemMix",
    title: "Item mix",
    description:
      "Share of all items sold and of net item sales on CLOSED orders (after item discounts, before order discounts), across the whole menu.",
    columns: [
      { key: "code", label: "Item code", kind: "text" },
      { key: "name", label: "Item", kind: "text" },
      { key: "quantity", label: "Quantity sold", kind: "count" },
      { key: "quantityPercent", label: "% of items", kind: "percent" },
      { key: "netSales", label: "Net item sales", kind: "money" },
      { key: "salesPercent", label: "% of item sales", kind: "percent" },
    ],
    rows: rows.map((row) => ({
      code: row.code,
      name: row.name,
      quantity: row.quantity,
      quantityPercent: row.quantity_percent,
      netSales: row.net_sales,
      salesPercent: row.sales_percent,
    })),
  };

  if (!context.canViewCost) {
    return [mix, (await itemMixByCategorySections(context)).mix];
  }

  const classes = classifyMenuItems(
    rows.map((row) => ({ key: `${row.code}\u0000${row.name}`, quantity: row.quantity, marginTotal: row.margin })),
  );
  const marginColumns: ReportColumn[] = [
    { key: "theoreticalCost", label: "Theoretical food cost", kind: "cost" },
    { key: "margin", label: "Contribution margin", kind: "money" },
    { key: "class", label: "Class", kind: "text" },
  ];

  const byCategory = await itemMixByCategorySections(context);

  return [
    mix,
    byCategory.mix,
    {
      key: "menuEngineering",
      title: "Menu engineering",
      description:
        "Popular: sold at least 70% of an even share of all items. High margin: contribution margin per item at or above the weighted average. Star = both, Plowhorse = popular only, Puzzle = margin only, Dog = neither. Items with no recipe cost are not placed.",
      columns: [
        { key: "code", label: "Item code", kind: "text" },
        { key: "name", label: "Item", kind: "text" },
        { key: "quantity", label: "Quantity sold", kind: "count" },
        { key: "netSales", label: "Net item sales", kind: "money" },
        ...marginColumns,
      ],
      rows: rows.map((row) => ({
        code: row.code,
        name: row.name,
        quantity: row.quantity,
        netSales: row.net_sales,
        theoreticalCost: row.cost,
        margin: row.margin,
        class: ENGINEERING_LABEL[classes.get(`${row.code}\u0000${row.name}`)!],
      })),
    },
    byCategory.engineering,
  ];
}

const UNCATEGORIZED = "Uncategorized";

type CategoryMixRow = MixRow & { category: string };

/**
 * Phase 20 (policies 1 and 2): item mix and menu engineering within the category each item was
 * sold under, from the SEND snapshot. Items sent before Phase 20 have none: "Uncategorized".
 */
async function itemMixByCategorySections(
  context: ReportContext,
): Promise<{ mix: ReportSection; engineering: ReportSection }> {
  const rows = await rowsOf<CategoryMixRow>(
    context,
    sql`
      WITH lines AS (
        SELECT COALESCE(oi.menu_category_name_snapshot, ${UNCATEGORIZED}) AS category,
               oi.menu_item_code_snapshot AS code, oi.menu_item_name_snapshot AS name, oi.quantity,
               ${soldLineTotal}
                 - COALESCE((SELECT SUM(d.applied_amount) FROM order_item_discounts d
                              WHERE d.order_item_id = oi.id AND d.status = 'APPLIED'), 0) AS net,
               (SELECT SUM(t.total_cost) FROM order_item_inventory_consumption c
                  JOIN inventory_transactions t ON t.id = c.inventory_transaction_id
                 WHERE c.order_item_id = oi.id) AS cost,
               EXISTS (SELECT 1 FROM order_item_inventory_consumption c WHERE c.order_item_id = oi.id) AS has_consumption
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${closedScope(context)} AND oi.status IN ${SOLD_ITEM_STATUSES}
      ),
      grouped AS (
        SELECT category, code, name, SUM(quantity)::int AS quantity, SUM(net) AS net,
               CASE WHEN bool_and(has_consumption) THEN SUM(cost) END AS cost
        FROM lines GROUP BY category, code, name
      )
      SELECT category, code, name, quantity,
             net::numeric(14,2)::text AS net_sales,
             ROUND(quantity * 100.0 / NULLIF(SUM(quantity) OVER (PARTITION BY category), 0), 2)::text AS quantity_percent,
             ROUND(net * 100 / NULLIF(SUM(net) OVER (PARTITION BY category), 0), 2)::text AS sales_percent,
             cost::numeric(14,4)::text AS cost,
             CASE WHEN cost IS NULL THEN NULL ELSE ROUND(net - cost, 2)::text END AS margin
      FROM grouped
      ORDER BY category = ${UNCATEGORIZED}, category, quantity DESC, code, name
    `,
  );
  const keyOf = (row: CategoryMixRow) => `${row.category}\u0000${row.code}\u0000${row.name}`;
  const classes = new Map<string, string>();

  for (const category of new Set(rows.map((row) => row.category))) {
    const inCategory = rows.filter((row) => row.category === category);

    for (const [key, value] of classifyMenuItems(
      inCategory.map((row) => ({ key: keyOf(row), quantity: row.quantity, marginTotal: row.margin })),
    )) {
      classes.set(key, ENGINEERING_LABEL[value]);
    }
  }

  const base: ReportColumn[] = [
    { key: "category", label: "Category", kind: "text" },
    { key: "code", label: "Item code", kind: "text" },
    { key: "name", label: "Item", kind: "text" },
    { key: "quantity", label: "Quantity sold", kind: "count" },
  ];

  return {
    mix: {
      key: "itemMixByCategory",
      title: "Item mix by category",
      description:
        "Share of the items sold and of net item sales within the category each item was sold under (snapshotted at SEND). Items sent before categories were recorded show as Uncategorized.",
      columns: [
        ...base,
        { key: "quantityPercent", label: "% of category items", kind: "percent" },
        { key: "netSales", label: "Net item sales", kind: "money" },
        { key: "salesPercent", label: "% of category sales", kind: "percent" },
      ],
      rows: rows.map((row) => ({
        category: row.category,
        code: row.code,
        name: row.name,
        quantity: row.quantity,
        quantityPercent: row.quantity_percent,
        netSales: row.net_sales,
        salesPercent: row.sales_percent,
      })),
    },
    engineering: {
      key: "menuEngineeringByCategory",
      title: "Menu engineering by category",
      description:
        "The same Star, Plowhorse, Puzzle and Dog rule, comparing each item only with the others sold in its category.",
      columns: [
        ...base,
        { key: "netSales", label: "Net item sales", kind: "money" },
        { key: "theoreticalCost", label: "Theoretical food cost", kind: "cost" },
        { key: "margin", label: "Contribution margin", kind: "money" },
        { key: "class", label: "Class", kind: "text" },
      ],
      rows: rows.map((row) => ({
        category: row.category,
        code: row.code,
        name: row.name,
        quantity: row.quantity,
        netSales: row.net_sales,
        theoreticalCost: row.cost,
        margin: row.margin,
        class: classes.get(keyOf(row))!,
      })),
    },
  };
}

// ------------------------------------------------------------------ server performance

/** Policy 22: richer figures per server on CLOSED checks; tips only with tip permissions. */
export async function serverPerformanceSection(context: ReportContext): Promise<ReportSection> {
  const { filters } = context;
  const rows = await rowsOf<{
    employee_number: string | null;
    server_name: string | null;
    checks: number;
    covers: number;
    net_sales: string;
    average_check: string | null;
    per_cover: string | null;
    items_per_check: string | null;
    duration: string | null;
    voided: string;
    comps: string;
    discounts: string;
    tips: string;
  }>(
    context,
    sql`
      WITH closed AS (
        SELECT o.id, o.assigned_server_employee_id, o.subtotal, o.table_session_id, o.opened_at, o.closed_at
        FROM orders o
        WHERE ${closedScope(context)}
          ${filters.employeeId ? sql`AND o.assigned_server_employee_id = ${filters.employeeId}` : sql``}
      ),
      covers AS (
        SELECT c.id,
               CASE WHEN ROW_NUMBER() OVER (PARTITION BY c.table_session_id ORDER BY c.opened_at, c.id) = 1
                    THEN ts.party_size ELSE 0 END AS covers
        FROM closed c JOIN table_sessions ts ON ts.id = c.table_session_id
      ),
      per_order AS (
        SELECT c.*,
               COALESCE(cv.covers, 0) AS covers,
               (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                 WHERE oi.order_id = c.id AND oi.status IN ${SOLD_ITEM_STATUSES}) AS items,
               (SELECT COALESCE(SUM(oi.line_total_snapshot), 0) FROM order_items oi
                 WHERE oi.order_id = c.id AND oi.status = 'VOIDED' AND oi.submitted_at IS NOT NULL) AS voided,
               (SELECT COALESCE(SUM(x.applied_amount) FILTER (WHERE x.is_comp), 0) FROM (
                  SELECT d.applied_amount, d.is_comp FROM order_discounts d WHERE d.order_id = c.id AND d.status = 'APPLIED'
                  UNION ALL
                  SELECT d.applied_amount, d.is_comp FROM order_item_discounts d
                    JOIN order_items oi ON oi.id = d.order_item_id
                   WHERE oi.order_id = c.id AND d.status = 'APPLIED') x) AS comps,
               (SELECT COALESCE(SUM(x.applied_amount) FILTER (WHERE NOT x.is_comp), 0) FROM (
                  SELECT d.applied_amount, d.is_comp FROM order_discounts d WHERE d.order_id = c.id AND d.status = 'APPLIED'
                  UNION ALL
                  SELECT d.applied_amount, d.is_comp FROM order_item_discounts d
                    JOIN order_items oi ON oi.id = d.order_item_id
                   WHERE oi.order_id = c.id AND d.status = 'APPLIED') x) AS discounts,
               (SELECT COALESCE(SUM(t.tip_amount), 0) FROM order_settlements s
                  JOIN settlement_tenders t ON t.settlement_id = s.id
                 WHERE s.order_id = c.id AND s.status = 'COMPLETED' AND t.status = 'RECORDED') AS tips
        FROM closed c LEFT JOIN covers cv ON cv.id = c.id
      )
      SELECT e.employee_number,
             CASE WHEN e.id IS NULL THEN NULL
                  ELSE COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name END AS server_name,
             COUNT(*)::int AS checks,
             SUM(p.covers)::int AS covers,
             SUM(p.subtotal)::numeric(14,2)::text AS net_sales,
             ROUND(SUM(p.subtotal) / COUNT(*), 2)::text AS average_check,
             ROUND(SUM(p.subtotal) / NULLIF(SUM(p.covers), 0), 2)::text AS per_cover,
             ROUND(AVG(p.items), 2)::text AS items_per_check,
             AVG(EXTRACT(EPOCH FROM p.closed_at - p.opened_at) / 60)::text AS duration,
             SUM(p.voided)::numeric(14,2)::text AS voided,
             SUM(p.comps)::numeric(14,2)::text AS comps,
             SUM(p.discounts)::numeric(14,2)::text AS discounts,
             SUM(p.tips)::numeric(14,2)::text AS tips
      FROM per_order p
      LEFT JOIN employees e ON e.id = p.assigned_server_employee_id
      GROUP BY e.id, e.employee_number, e.preferred_name, e.first_name, e.last_name
      ORDER BY SUM(p.subtotal) DESC, e.employee_number NULLS LAST
    `,
  );

  return {
    key: "serverPerformance",
    title: "Server performance",
    description:
      "CLOSED checks by assigned server. Voids are sent items voided on those checks; comps and discounts are applied amounts." +
      (context.canViewTips ? " Tips are RECORDED tender tips." : ""),
    columns: [
      { key: "employeeNumber", label: "Employee #", kind: "text" },
      { key: "server", label: "Server", kind: "text" },
      { key: "checks", label: "Checks", kind: "count" },
      { key: "covers", label: "Covers", kind: "count" },
      { key: "netSales", label: "Net sales", kind: "money" },
      { key: "averageCheck", label: "Average check", kind: "money" },
      { key: "perCover", label: "Per cover", kind: "money" },
      { key: "itemsPerCheck", label: "Items per check", kind: "quantity" },
      { key: "duration", label: "Average check time", kind: "minutes" },
      { key: "voided", label: "Voided items", kind: "money" },
      { key: "comps", label: "Comps", kind: "money" },
      { key: "discounts", label: "Discounts", kind: "money" },
      ...(context.canViewTips ? [{ key: "tips", label: "Tips", kind: "money" } as ReportColumn] : []),
    ],
    rows: rows.map((row) => ({
      employeeNumber: row.employee_number,
      server: row.server_name ?? "No server",
      checks: row.checks,
      covers: row.covers,
      netSales: row.net_sales,
      averageCheck: row.average_check,
      perCover: row.per_cover,
      itemsPerCheck: row.items_per_check,
      duration: minutes(row.duration),
      voided: row.voided,
      comps: row.comps,
      discounts: row.discounts,
      ...(context.canViewTips ? { tips: row.tips } : {}),
    })),
  };
}

// ------------------------------------------------------------------ voids, comps, discounts by employee

/** Policy 23: facts by the employee who did it. No thresholds and no labels. */
export async function adjustmentsByEmployeeSection(context: ReportContext): Promise<ReportSection> {
  const { filters } = context;
  const scope = sql`
    o.location_id = ${filters.locationId}
    AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
  `;
  const rows = await rowsOf<{
    employee_number: string | null;
    actor_name: string | null;
    voids: number;
    void_amount: string;
    comps: number;
    comp_amount: string;
    discounts: number;
    discount_amount: string;
    served_sales: string;
    percent_of_served: string | null;
    reasons: string | null;
  }>(
    context,
    sql`
      WITH actions AS (
        SELECT v.voided_by_user_id AS user_id, 'VOID' AS kind, oi.line_total_snapshot AS amount, v.reason
        FROM order_item_voids v
        JOIN order_items oi ON oi.id = v.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE ${scope}
        UNION ALL
        SELECT d.applied_by_user_id, CASE WHEN d.is_comp THEN 'COMP' ELSE 'DISCOUNT' END, d.applied_amount, d.reason
        FROM order_discounts d JOIN orders o ON o.id = d.order_id
        WHERE ${scope} AND o.status <> 'VOIDED' AND d.status = 'APPLIED'
        UNION ALL
        SELECT d.applied_by_user_id, CASE WHEN d.is_comp THEN 'COMP' ELSE 'DISCOUNT' END, d.applied_amount, d.reason
        FROM order_item_discounts d
        JOIN order_items oi ON oi.id = d.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE ${scope} AND o.status <> 'VOIDED' AND d.status = 'APPLIED'
      ),
      served AS (
        SELECT e.user_id, SUM(o.subtotal) AS sales
        FROM orders o JOIN employees e ON e.id = o.assigned_server_employee_id
        WHERE ${scope} AND o.status = 'CLOSED' AND e.user_id IS NOT NULL
        GROUP BY e.user_id
      ),
      per_actor AS (
        SELECT a.user_id,
               (COUNT(*) FILTER (WHERE kind = 'VOID'))::int AS voids,
               COALESCE(SUM(amount) FILTER (WHERE kind = 'VOID'), 0) AS void_amount,
               (COUNT(*) FILTER (WHERE kind = 'COMP'))::int AS comps,
               COALESCE(SUM(amount) FILTER (WHERE kind = 'COMP'), 0) AS comp_amount,
               (COUNT(*) FILTER (WHERE kind = 'DISCOUNT'))::int AS discounts,
               COALESCE(SUM(amount) FILTER (WHERE kind = 'DISCOUNT'), 0) AS discount_amount,
               SUM(amount) AS total,
               string_agg(DISTINCT reason, '; ' ORDER BY reason) AS reasons
        FROM actions a GROUP BY a.user_id
      )
      SELECT e.employee_number,
             CASE WHEN e.id IS NULL THEN NULL
                  ELSE COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name END AS actor_name,
             p.voids, p.void_amount::numeric(14,2)::text AS void_amount,
             p.comps, p.comp_amount::numeric(14,2)::text AS comp_amount,
             p.discounts, p.discount_amount::numeric(14,2)::text AS discount_amount,
             COALESCE(s.sales, 0)::numeric(14,2)::text AS served_sales,
             ROUND(p.total * 100 / NULLIF(s.sales, 0), 2)::text AS percent_of_served,
             p.reasons
      FROM per_actor p
      LEFT JOIN employees e ON e.user_id = p.user_id
      LEFT JOIN served s ON s.user_id = p.user_id
      ORDER BY p.total DESC, e.employee_number NULLS LAST
    `,
  );

  return {
    key: "adjustmentsByEmployee",
    title: "Voids, comps and discounts by employee",
    description:
      "By the person who voided the item or applied the comp or discount. % of own sales compares that total with net sales on CLOSED checks they served. Facts only: no thresholds are applied.",
    columns: [
      { key: "employeeNumber", label: "Employee #", kind: "text" },
      { key: "employee", label: "Employee", kind: "text" },
      { key: "voids", label: "Voids", kind: "count" },
      { key: "voidAmount", label: "Void value", kind: "money" },
      { key: "comps", label: "Comps", kind: "count" },
      { key: "compAmount", label: "Comp amount", kind: "money" },
      { key: "discounts", label: "Discounts", kind: "count" },
      { key: "discountAmount", label: "Discount amount", kind: "money" },
      { key: "servedSales", label: "Own net sales", kind: "money" },
      { key: "percentOfServed", label: "% of own sales", kind: "percent" },
      { key: "reasons", label: "Reasons", kind: "text" },
    ],
    rows: rows.map((row) => ({
      employeeNumber: row.employee_number,
      employee: row.actor_name ?? "User without an employee record",
      voids: row.voids,
      voidAmount: row.void_amount,
      comps: row.comps,
      compAmount: row.comp_amount,
      discounts: row.discounts,
      discountAmount: row.discount_amount,
      servedSales: row.served_sales,
      percentOfServed: row.percent_of_served,
      reasons: row.reasons,
    })),
  };
}

// ------------------------------------------------------------------ 86 history

/** Policy 24: manual 86s and sell-anyway overrides that began in the range. */
export async function eightySixHistorySection(context: ReportContext): Promise<ReportSection> {
  const { filters } = context;
  const zone = context.settings.timeZone;
  const rows = await rowsOf<{
    kind: string;
    code: string;
    name: string;
    reason: string;
    by_name: string | null;
    started: string;
    ended: string | null;
    duration: string | null;
  }>(
    context,
    sql`
      WITH entries AS (
        SELECT '86' AS kind, x.menu_item_id, x.reason, x.marked_out_by_user_id AS by_user,
               x.marked_out_at AS started, x.restored_at AS ended
        FROM menu_item_outages x
        WHERE x.location_id = ${filters.locationId}
          AND x.marked_out_at >= ${context.start}::timestamptz AND x.marked_out_at < ${context.end}::timestamptz
        UNION ALL
        SELECT 'Sell anyway', x.menu_item_id, x.reason, x.set_by_user_id, x.set_at, x.cleared_at
        FROM menu_item_stock_overrides x
        WHERE x.location_id = ${filters.locationId}
          AND x.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      )
      SELECT en.kind, mi.code, mi.name, en.reason,
             CASE WHEN e.id IS NULL THEN NULL
                  ELSE COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name END AS by_name,
             to_char(en.started AT TIME ZONE ${zone}, 'YYYY-MM-DD HH24:MI') AS started,
             to_char(en.ended AT TIME ZONE ${zone}, 'YYYY-MM-DD HH24:MI') AS ended,
             (EXTRACT(EPOCH FROM en.ended - en.started) / 60)::text AS duration
      FROM entries en
      JOIN menu_items mi ON mi.id = en.menu_item_id
      LEFT JOIN employees e ON e.user_id = en.by_user
      ORDER BY en.started, mi.code
    `,
  );

  return {
    key: "eightySixHistory",
    title: "86 history",
    description:
      "Items taken off sale here by hand (86), and sell-anyway overrides of auto-86, that began in the range. Local times.",
    columns: [
      { key: "kind", label: "Kind", kind: "text" },
      { key: "code", label: "Item code", kind: "text" },
      { key: "name", label: "Item", kind: "text" },
      { key: "reason", label: "Reason", kind: "text" },
      { key: "by", label: "By", kind: "text" },
      { key: "started", label: "From", kind: "text" },
      { key: "ended", label: "Until", kind: "text" },
      { key: "duration", label: "Duration", kind: "minutes" },
    ],
    rows: rows.map((row) => ({
      kind: row.kind,
      code: row.code,
      name: row.name,
      reason: row.reason,
      by: row.by_name,
      started: row.started,
      ended: row.ended ?? (row.kind === "86" ? "Still 86'd" : "End of day"),
      duration: minutes(row.duration),
    })),
  };
}
