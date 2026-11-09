import { sql } from "drizzle-orm";

import type { ReportColumn, ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

const TYPE_LABEL: Record<string, string> = {
  RECEIVE: "Received",
  CONSUME: "Sold (consumed)",
  SALE_REVERSAL: "Sale reversal",
  WASTE: "Waste",
  ADJUST_INCREASE: "Adjustment +",
  ADJUST_DECREASE: "Adjustment −",
  COUNT_INCREASE: "Count variance +",
  COUNT_DECREASE: "Count variance −",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
};

/**
 * Inventory analytics from the authoritative ledger (`inventory_transactions`) only, by its
 * business date. Quantities are in each item's base unit. Costs are the costs posted on each
 * movement and appear only with `inventory.cost.view`. The closing quantity is the ledger's
 * `quantity_after` at the end of the range, not today's balance.
 */
export async function inventorySections(context: ReportContext): Promise<ReportSection[]> {
  const { filters, canViewCost } = context;
  const inRange = sql`
    t.location_id = ${filters.locationId}
    AND t.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
  `;
  const signedCost = sql`(CASE WHEN t.base_quantity_delta < 0 THEN -t.total_cost ELSE t.total_cost END)`;

  const usage = await rowsOf<{
    code: string;
    name: string;
    unit: string;
    received: string;
    theoretical: string;
    waste: string;
    count_variance: string;
    adjustments: string;
    transfers: string;
    closing: string | null;
    theoretical_cost: string | null;
    waste_cost: string | null;
    variance_cost: string | null;
  }>(
    context,
    sql`
      WITH moved AS (
        SELECT t.inventory_item_id,
               SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type = 'RECEIVE') AS received,
               -SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type IN ('CONSUME', 'SALE_REVERSAL')) AS theoretical,
               -SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type = 'WASTE') AS waste,
               SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type IN ('COUNT_INCREASE', 'COUNT_DECREASE')) AS count_variance,
               SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type IN ('ADJUST_INCREASE', 'ADJUST_DECREASE')) AS adjustments,
               SUM(t.base_quantity_delta) FILTER (WHERE t.transaction_type IN ('TRANSFER_IN', 'TRANSFER_OUT')) AS transfers,
               -SUM(${signedCost}) FILTER (WHERE t.transaction_type IN ('CONSUME', 'SALE_REVERSAL')) AS theoretical_cost,
               SUM(t.total_cost) FILTER (WHERE t.transaction_type = 'WASTE') AS waste_cost,
               SUM(${signedCost}) FILTER (WHERE t.transaction_type IN ('COUNT_INCREASE', 'COUNT_DECREASE')) AS variance_cost
        FROM inventory_transactions t
        WHERE ${inRange}
        GROUP BY t.inventory_item_id
      ),
      closing AS (
        SELECT DISTINCT ON (t.inventory_item_id) t.inventory_item_id, t.quantity_after
        FROM inventory_transactions t
        WHERE t.location_id = ${filters.locationId} AND t.business_date <= ${filters.to}::date
          AND t.inventory_item_id IN (SELECT inventory_item_id FROM moved)
        ORDER BY t.inventory_item_id, t.sequence DESC
      )
      SELECT i.code, i.name, u.code AS unit,
             COALESCE(m.received, 0)::numeric(14,4)::text AS received,
             COALESCE(m.theoretical, 0)::numeric(14,4)::text AS theoretical,
             COALESCE(m.waste, 0)::numeric(14,4)::text AS waste,
             COALESCE(m.count_variance, 0)::numeric(14,4)::text AS count_variance,
             COALESCE(m.adjustments, 0)::numeric(14,4)::text AS adjustments,
             COALESCE(m.transfers, 0)::numeric(14,4)::text AS transfers,
             c.quantity_after::numeric(14,4)::text AS closing,
             m.theoretical_cost::numeric(14,4)::text AS theoretical_cost,
             m.waste_cost::numeric(14,4)::text AS waste_cost,
             m.variance_cost::numeric(14,4)::text AS variance_cost
      FROM moved m
      JOIN inventory_items i ON i.id = m.inventory_item_id
      JOIN units_of_measure u ON u.id = i.base_unit_id
      LEFT JOIN closing c ON c.inventory_item_id = m.inventory_item_id
      ORDER BY i.name, i.code
    `,
  );

  const movements = await rowsOf<{
    code: string;
    name: string;
    unit: string;
    transaction_type: string;
    movements: number;
    quantity: string;
    cost: string | null;
  }>(
    context,
    sql`
      SELECT i.code, i.name, u.code AS unit, t.transaction_type,
             COUNT(*)::int AS movements,
             SUM(t.base_quantity_delta)::numeric(14,4)::text AS quantity,
             SUM(${signedCost})::numeric(14,4)::text AS cost
      FROM inventory_transactions t
      JOIN inventory_items i ON i.id = t.inventory_item_id
      JOIN units_of_measure u ON u.id = i.base_unit_id
      WHERE ${inRange}
      GROUP BY i.code, i.name, u.code, t.transaction_type
      ORDER BY i.name, i.code, t.transaction_type
    `,
  );

  const waste = await rowsOf<{ code: string; name: string; unit: string; reason: string | null; quantity: string; cost: string | null }>(
    context,
    sql`
      SELECT i.code, i.name, u.code AS unit, t.reason_code AS reason,
             (-SUM(t.base_quantity_delta))::numeric(14,4)::text AS quantity,
             SUM(t.total_cost)::numeric(14,4)::text AS cost
      FROM inventory_transactions t
      JOIN inventory_items i ON i.id = t.inventory_item_id
      JOIN units_of_measure u ON u.id = i.base_unit_id
      WHERE ${inRange} AND t.transaction_type = 'WASTE'
      GROUP BY i.code, i.name, u.code, t.reason_code
      ORDER BY SUM(t.total_cost) DESC NULLS LAST, i.name
    `,
  );

  const receipts = await rowsOf<{ supplier: string; receipts: number; lines: number; total_cost: string }>(
    context,
    sql`
      SELECT sp.name AS supplier, COUNT(DISTINCT r.id)::int AS receipts, COUNT(l.id)::int AS lines,
             SUM(l.total_cost)::numeric(14,4)::text AS total_cost
      FROM purchase_order_receipts r
      JOIN purchase_orders po ON po.id = r.purchase_order_id
      JOIN suppliers sp ON sp.id = po.supplier_id
      JOIN purchase_order_receipt_lines l ON l.receipt_id = r.id
      WHERE r.location_id = ${filters.locationId}
        AND r.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY sp.name
      ORDER BY SUM(l.total_cost) DESC, sp.name
    `,
  );

  const costChanges = canViewCost
    ? await rowsOf<{
        supplier: string;
        item_code: string;
        item_name: string;
        sku: string | null;
        /** Raw queries return timestamps as text, not Date. */
        recorded_at: string | Date;
        source: string;
        unit_cost: string;
        previous_cost: string | null;
      }>(
        context,
        sql`
          WITH history AS (
            SELECT h.supplier_item_id, h.recorded_at, h.source, h.unit_cost,
                   LAG(h.unit_cost) OVER (PARTITION BY h.supplier_item_id ORDER BY h.recorded_at, h.id) AS previous_cost
            FROM supplier_item_cost_history h
            JOIN supplier_items si ON si.id = h.supplier_item_id
            WHERE si.inventory_item_id IN (
              SELECT inventory_item_id FROM inventory_item_locations WHERE location_id = ${filters.locationId}
            )
          )
          SELECT sp.name AS supplier, i.code AS item_code, i.name AS item_name, si.supplier_sku AS sku,
                 h.recorded_at, h.source, h.unit_cost::text AS unit_cost, h.previous_cost::text AS previous_cost
          FROM history h
          JOIN supplier_items si ON si.id = h.supplier_item_id
          JOIN suppliers sp ON sp.id = si.supplier_id
          JOIN inventory_items i ON i.id = si.inventory_item_id
          WHERE h.recorded_at >= ${context.start}::timestamptz AND h.recorded_at < ${context.end}::timestamptz
          ORDER BY h.recorded_at, sp.name, i.code
        `,
      )
    : [];

  const costColumn = (key: string, label: string): ReportColumn[] =>
    canViewCost ? [{ key, label, kind: "cost" }] : [];
  const withCost = <Row extends object>(row: Row, values: Record<string, string | null>) =>
    canViewCost ? { ...row, ...values } : row;

  const sections: ReportSection[] = [
    {
      key: "usage",
      title: "Usage and variance by item",
      description:
        "Theoretical usage is what sales consumed (net of sale reversals); count variance is what counts found beyond it. Closing quantity is the ledger at the end of the range.",
      columns: [
        { key: "code", label: "Item code", kind: "text" },
        { key: "name", label: "Item", kind: "text" },
        { key: "unit", label: "Base unit", kind: "text" },
        { key: "received", label: "Received", kind: "quantity" },
        { key: "theoretical", label: "Theoretical usage", kind: "quantity" },
        { key: "waste", label: "Waste", kind: "quantity" },
        { key: "countVariance", label: "Count variance", kind: "quantity" },
        { key: "adjustments", label: "Adjustments", kind: "quantity" },
        { key: "transfers", label: "Transfers (net)", kind: "quantity" },
        { key: "closing", label: "Closing quantity", kind: "quantity" },
        ...costColumn("theoreticalCost", "Theoretical cost"),
        ...costColumn("wasteCost", "Waste cost"),
        ...costColumn("varianceCost", "Count variance cost"),
      ],
      rows: usage.map((row) =>
        withCost(
          {
            code: row.code,
            name: row.name,
            unit: row.unit,
            received: row.received,
            theoretical: row.theoretical,
            waste: row.waste,
            countVariance: row.count_variance,
            adjustments: row.adjustments,
            transfers: row.transfers,
            closing: row.closing,
          },
          {
            theoreticalCost: row.theoretical_cost,
            wasteCost: row.waste_cost,
            varianceCost: row.variance_cost,
          },
        ),
      ),
    },
    {
      key: "waste",
      title: "Waste by item and reason",
      columns: [
        { key: "code", label: "Item code", kind: "text" },
        { key: "name", label: "Item", kind: "text" },
        { key: "unit", label: "Base unit", kind: "text" },
        { key: "reason", label: "Reason", kind: "text" },
        { key: "quantity", label: "Quantity", kind: "quantity" },
        ...costColumn("cost", "Cost"),
      ],
      rows: waste.map((row) =>
        withCost(
          { code: row.code, name: row.name, unit: row.unit, reason: row.reason, quantity: row.quantity },
          { cost: row.cost },
        ),
      ),
    },
    {
      key: "movements",
      title: "Ledger movements",
      description: "Signed: positive added stock, negative removed it.",
      columns: [
        { key: "code", label: "Item code", kind: "text" },
        { key: "name", label: "Item", kind: "text" },
        { key: "unit", label: "Base unit", kind: "text" },
        { key: "type", label: "Movement", kind: "text" },
        { key: "movements", label: "Entries", kind: "count" },
        { key: "quantity", label: "Quantity", kind: "quantity" },
        ...costColumn("cost", "Cost"),
      ],
      rows: movements.map((row) =>
        withCost(
          {
            code: row.code,
            name: row.name,
            unit: row.unit,
            type: TYPE_LABEL[row.transaction_type] ?? row.transaction_type,
            movements: row.movements,
            quantity: row.quantity,
          },
          { cost: row.cost },
        ),
      ),
    },
    {
      key: "receipts",
      title: "Purchasing receipts by supplier",
      columns: [
        { key: "supplier", label: "Supplier", kind: "text" },
        { key: "receipts", label: "Receipts", kind: "count" },
        { key: "lines", label: "Lines", kind: "count" },
        ...costColumn("totalCost", "Received cost"),
      ],
      rows: receipts.map((row) =>
        withCost(
          { supplier: row.supplier, receipts: row.receipts, lines: row.lines },
          { totalCost: row.total_cost },
        ),
      ),
    },
  ];

  if (canViewCost) {
    sections.push({
      key: "supplier-costs",
      title: "Supplier cost changes",
      description: "Supplier cost history recorded in the range, for items stocked at this location.",
      columns: [
        { key: "recordedAt", label: "Recorded", kind: "text" },
        { key: "supplier", label: "Supplier", kind: "text" },
        { key: "itemCode", label: "Item code", kind: "text" },
        { key: "itemName", label: "Item", kind: "text" },
        { key: "sku", label: "Supplier SKU", kind: "text" },
        { key: "source", label: "Source", kind: "text" },
        { key: "previousCost", label: "Previous unit cost", kind: "cost" },
        { key: "unitCost", label: "Unit cost", kind: "cost" },
      ],
      rows: costChanges.map((row) => ({
        recordedAt: new Date(row.recorded_at).toISOString(),
        supplier: row.supplier,
        itemCode: row.item_code,
        itemName: row.item_name,
        sku: row.sku,
        source: row.source,
        previousCost: row.previous_cost,
        unitCost: row.unit_cost,
      })),
    });
  }

  return sections;
}
