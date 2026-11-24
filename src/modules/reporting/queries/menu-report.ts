import { sql } from "drizzle-orm";

import type { ReportColumn, ReportSection } from "../types";

import { rowsOf, SOLD_ITEM_STATUSES, soldLineTotal, type ReportContext } from "./report-context";

type ItemRow = {
  code: string;
  name: string;
  quantity: number;
  gross_sales: string;
  item_discounts: string;
  theoretical_cost: string | null;
  margin: string | null;
  cost_percent: string | null;
};

type ModifierRow = {
  group_name: string;
  modifier_name: string;
  quantity: number;
  revenue: string;
};

/**
 * Menu performance on CLOSED orders, from submitted item snapshots (code, name, line totals).
 * Theoretical food cost is the cost actually posted by each item's SEND consumption ledger
 * rows (`order_item_inventory_consumption`), never today's recipe or cost.
 */
export async function menuSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const scope = sql`
    o.location_id = ${filters.locationId}
    AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    AND o.status = 'CLOSED'
    AND oi.status IN ${SOLD_ITEM_STATUSES}
    AND oi.bundle_parent_order_item_id IS NULL
    ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
  `;

  const items = await rowsOf<ItemRow>(
    context,
    sql`
      WITH lines AS (
        SELECT oi.menu_item_code_snapshot AS code, oi.menu_item_name_snapshot AS name, oi.quantity,
               ${soldLineTotal} AS line_total_snapshot,
               (SELECT SUM(d.applied_amount) FROM order_item_discounts d
                 WHERE d.order_item_id = oi.id AND d.status = 'APPLIED') AS item_discounts,
               (SELECT SUM(t.total_cost) FROM order_item_inventory_consumption c
                  JOIN inventory_transactions t ON t.id = c.inventory_transaction_id
                 WHERE c.order_item_id IN (SELECT oi.id UNION ALL SELECT ch.id FROM order_items ch WHERE ch.bundle_parent_order_item_id = oi.id)) AS consumption_cost
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${scope}
      ),
      grouped AS (
        SELECT code, name, SUM(quantity)::int AS quantity,
               SUM(line_total_snapshot) AS gross, COALESCE(SUM(item_discounts), 0) AS discounts,
               SUM(consumption_cost) AS cost
        FROM lines GROUP BY code, name
      )
      SELECT code, name, quantity,
             gross::numeric(14,2)::text AS gross_sales,
             discounts::numeric(14,2)::text AS item_discounts,
             cost::numeric(14,4)::text AS theoretical_cost,
             CASE WHEN cost IS NULL THEN NULL ELSE ROUND(gross - cost, 2)::text END AS margin,
             CASE WHEN cost IS NULL OR gross = 0 THEN NULL ELSE ROUND(cost * 100 / gross, 2)::text END AS cost_percent
      FROM grouped
      ORDER BY gross DESC, code, name
    `,
  );

  const modifiers = await rowsOf<ModifierRow>(
    context,
    sql`
      SELECT m.modifier_group_name_snapshot AS group_name, m.modifier_name_snapshot AS modifier_name,
             SUM(oi.quantity)::int AS quantity,
             SUM(m.price_adjustment_snapshot * oi.quantity)::numeric(14,2)::text AS revenue
      FROM order_item_modifiers m
      JOIN order_items oi ON oi.id = m.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE ${scope}
      GROUP BY m.modifier_group_name_snapshot, m.modifier_name_snapshot
      ORDER BY quantity DESC, group_name, modifier_name
    `,
  );

  // Phase 36 (policy 9): what bundles were made of, by bundle and course. Components carry no
  // price of their own; the upcharge column is what each choice added to its bundle's price.
  const components = await rowsOf<{ bundle: string; course: string; component: string; quantity: number; upcharges: string }>(
    context,
    sql`
      SELECT oi.bundle_name_snapshot AS bundle, oi.bundle_slot_name_snapshot AS course,
             oi.menu_item_name_snapshot AS component, SUM(oi.quantity)::int AS quantity,
             SUM(oi.bundle_upcharge_snapshot * oi.quantity)::numeric(14,2)::text AS upcharges
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = ${filters.locationId}
        AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND o.status = 'CLOSED'
        AND oi.status IN ${SOLD_ITEM_STATUSES}
        AND oi.bundle_parent_order_item_id IS NOT NULL
        ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
      GROUP BY oi.bundle_name_snapshot, oi.bundle_slot_name_snapshot, oi.menu_item_name_snapshot
      ORDER BY bundle, course, quantity DESC, component
    `,
  );

  const costColumns: ReportColumn[] = context.canViewCost
    ? [
        { key: "theoreticalCost", label: "Theoretical food cost", kind: "cost" },
        { key: "margin", label: "Margin", kind: "money" },
        { key: "costPercent", label: "Food cost %", kind: "percent" },
      ]
    : [];

  return [
    {
      key: "items",
      title: "Menu items",
      description:
        "Items on CLOSED orders, at the price snapshotted when sent. Item discounts exclude order-level discounts.",
      columns: [
        { key: "code", label: "Item code", kind: "text" },
        { key: "name", label: "Item", kind: "text" },
        { key: "quantity", label: "Quantity sold", kind: "count" },
        { key: "grossSales", label: "Gross sales", kind: "money" },
        { key: "itemDiscounts", label: "Item discounts", kind: "money" },
        ...costColumns,
      ],
      rows: items.map((row) => ({
        code: row.code,
        name: row.name,
        quantity: row.quantity,
        grossSales: row.gross_sales,
        itemDiscounts: row.item_discounts,
        ...(context.canViewCost
          ? { theoreticalCost: row.theoretical_cost, margin: row.margin, costPercent: row.cost_percent }
          : {}),
      })),
    },
    {
      key: "modifiers",
      title: "Modifiers",
      columns: [
        { key: "group", label: "Modifier group", kind: "text" },
        { key: "modifier", label: "Modifier", kind: "text" },
        { key: "quantity", label: "Times sold", kind: "count" },
        { key: "revenue", label: "Price adjustments", kind: "money" },
      ],
      rows: modifiers.map((row) => ({
        group: row.group_name,
        modifier: row.modifier_name,
        quantity: row.quantity,
        revenue: row.revenue,
      })),
    },
    {
      key: "bundle-components",
      title: "Bundle components",
      description: "The courses chosen in prix-fixe and combo items. Their sales and cost are on the bundle's own row.",
      columns: [
        { key: "bundle", label: "Bundle", kind: "text" },
        { key: "course", label: "Course", kind: "text" },
        { key: "component", label: "Choice", kind: "text" },
        { key: "quantity", label: "Times chosen", kind: "count" },
        { key: "upcharges", label: "Upcharges", kind: "money" },
      ],
      rows: components.map((row) => ({
        bundle: row.bundle,
        course: row.course,
        component: row.component,
        quantity: row.quantity,
        upcharges: row.upcharges,
      })),
    },
  ];
}
