import { sql } from "drizzle-orm";

import type { ReportColumn, ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

const COSTING_LABEL: Record<string, string> = {
  WEIGHTED_AVERAGE: "Weighted average",
  LOT: "By lot",
};

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
    closing_value: string | null;
    costing_method: string;
    method_changed: boolean;
    theoretical_cost: string | null;
    waste_cost: string | null;
    variance_cost: string | null;
  }>(
    context,
    sql`
      WITH moved AS (
        SELECT t.inventory_item_id,
               MIN(t.sequence) AS first_sequence,
               MAX(t.sequence) AS last_sequence,
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
        SELECT DISTINCT ON (t.inventory_item_id) t.inventory_item_id, t.quantity_after,
               -- Phase 37 (policy 8): a lot-costed row carries its stock value; otherwise
               -- quantity x average, as the Inventory page values it.
               COALESCE(t.stock_value_after,
                        CASE WHEN t.quantity_after >= 0 AND t.average_cost_after IS NOT NULL
                             THEN round(t.quantity_after * t.average_cost_after, 4) END) AS closing_value
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
             c.closing_value::numeric(14,4)::text AS closing_value,
             i.costing_method,
             -- Phase 37 (policy 9): the method changed between movements inside the range.
             EXISTS (
               SELECT 1 FROM inventory_costing_changes cc
               WHERE cc.inventory_item_id = m.inventory_item_id AND cc.location_id = ${filters.locationId}
                 AND cc.last_transaction_sequence >= m.first_sequence
                 AND cc.last_transaction_sequence < m.last_sequence
             ) AS method_changed,
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
        "Theoretical usage is what sales consumed (net of sale reversals); count variance is what counts found beyond it. Closing quantity is the ledger at the end of the range. Costs are as posted: an item costed by lot is costed from the lots it used, and where its method changed in the range, the rows before and after the change keep the method they were posted under.",
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
        { key: "method", label: "Costing", kind: "text" },
        ...costColumn("closingValue", "Closing value"),
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
            method:
              (COSTING_LABEL[row.costing_method] ?? row.costing_method) +
              (row.method_changed ? " (method changed in this range)" : ""),
          },
          {
            closingValue: row.closing_value,
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

  if (canViewCost) {
    sections.push(...(await invoiceSections(context)));
    sections.push(...(await lotCostingSections(context)));
  }

  return sections;
}

/**
 * Phase 36 (policy 8): approved supplier invoices' stored variances, by invoice date, and
 * received lines no live invoice holds yet, by receipt date. Information only: invoices never
 * change inventory cost.
 */
async function invoiceSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const variances = await rowsOf<{
    invoice_number: string;
    invoice_date: string;
    supplier: string;
    item: string;
    received_quantity: string;
    invoiced_quantity: string;
    quantity_variance: string;
    receipt_unit_cost: string;
    invoiced_unit_price: string;
    price_variance: string;
    amount_variance: string;
    within_tolerance: boolean;
  }>(
    context,
    sql`
      SELECT i.invoice_number, i.invoice_date::text AS invoice_date, s.name AS supplier, ii.name AS item,
             v.received_quantity::text, v.invoiced_quantity::text, v.quantity_variance::text,
             v.receipt_unit_cost::text, v.invoiced_unit_price::text, v.price_variance::text,
             v.amount_variance::text, v.within_tolerance
      FROM supplier_invoice_variances v
      JOIN supplier_invoices i ON i.id = v.invoice_id
      JOIN suppliers s ON s.id = i.supplier_id
      JOIN supplier_invoice_lines l ON l.id = v.invoice_line_id
      JOIN purchase_order_receipt_lines rl ON rl.id = l.receipt_line_id
      JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
      JOIN inventory_items ii ON ii.id = pol.inventory_item_id
      WHERE i.location_id = ${filters.locationId}
        AND i.status = 'APPROVED'
        AND i.invoice_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND (v.quantity_variance <> 0 OR v.price_variance <> 0)
      ORDER BY i.invoice_date, i.invoice_number, ii.name
    `,
  );
  const uninvoiced = await rowsOf<{
    received_on: string;
    po_number: string;
    supplier: string;
    item: string;
    received_quantity: string;
    total_cost: string;
    age_days: number;
  }>(
    context,
    sql`
      SELECT r.business_date::text AS received_on, po.po_number, s.name AS supplier, ii.name AS item,
             rl.received_quantity::text, rl.total_cost::text,
             (${filters.to}::date - r.business_date)::int AS age_days
      FROM purchase_order_receipt_lines rl
      JOIN purchase_order_receipts r ON r.id = rl.receipt_id
      JOIN purchase_orders po ON po.id = r.purchase_order_id
      JOIN suppliers s ON s.id = po.supplier_id
      JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
      JOIN inventory_items ii ON ii.id = pol.inventory_item_id
      WHERE r.location_id = ${filters.locationId}
        AND r.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND NOT EXISTS (
          SELECT 1 FROM supplier_invoice_lines l WHERE l.receipt_line_id = rl.id AND l.holds_receipt_line
        )
      ORDER BY r.business_date, po.po_number, ii.name
    `,
  );

  return [
    {
      key: "invoice-variances",
      title: "Invoice variances",
      description: "Approved supplier invoice lines that differ from what was received, as stored at approval. Inventory cost is unchanged.",
      columns: [
        { key: "invoiceDate", label: "Invoice date", kind: "date" },
        { key: "invoice", label: "Invoice", kind: "text" },
        { key: "supplier", label: "Supplier", kind: "text" },
        { key: "item", label: "Item", kind: "text" },
        { key: "received", label: "Received", kind: "quantity" },
        { key: "invoiced", label: "Invoiced", kind: "quantity" },
        { key: "quantityVariance", label: "Quantity variance", kind: "quantity" },
        { key: "receiptCost", label: "Receipt unit cost", kind: "cost" },
        { key: "invoicedPrice", label: "Invoiced unit price", kind: "cost" },
        { key: "priceVariance", label: "Price variance", kind: "cost" },
        { key: "amountVariance", label: "Amount variance", kind: "money" },
        { key: "withinTolerance", label: "Within tolerance", kind: "text" },
      ],
      rows: variances.map((row) => ({
        invoiceDate: row.invoice_date,
        invoice: row.invoice_number,
        supplier: row.supplier,
        item: row.item,
        received: row.received_quantity,
        invoiced: row.invoiced_quantity,
        quantityVariance: row.quantity_variance,
        receiptCost: row.receipt_unit_cost,
        invoicedPrice: row.invoiced_unit_price,
        priceVariance: row.price_variance,
        amountVariance: row.amount_variance,
        withinTolerance: row.within_tolerance ? "Yes" : "No",
      })),
    },
    {
      key: "received-not-invoiced",
      title: "Received, not invoiced",
      description: "Received lines in the range that no live supplier invoice holds yet, with their age at the end of the range.",
      columns: [
        { key: "receivedOn", label: "Received", kind: "date" },
        { key: "po", label: "Purchase order", kind: "text" },
        { key: "supplier", label: "Supplier", kind: "text" },
        { key: "item", label: "Item", kind: "text" },
        { key: "quantity", label: "Quantity (purchase units)", kind: "quantity" },
        { key: "receivedCost", label: "Received cost", kind: "cost" },
        { key: "ageDays", label: "Age (days)", kind: "count" },
      ],
      rows: uninvoiced.map((row) => ({
        receivedOn: row.received_on,
        po: row.po_number,
        supplier: row.supplier,
        item: row.item,
        quantity: row.received_quantity,
        receivedCost: row.total_cost,
        ageDays: row.age_days,
      })),
    },
  ];
}

/**
 * Phase 37 (policies 6 and 8): for items costed by lot, the differences left when a new lot
 * covered stock used beyond the lots (by the date the lot arrived), and the value of each
 * open lot now.
 */
async function lotCostingSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const differences = await rowsOf<{
    received_on: string;
    lot_number: string;
    item: string;
    unit: string;
    quantity: string;
    lot_value: string | null;
    difference: string;
  }>(
    context,
    sql`
      SELECT l.received_on::text, l.lot_number, i.name AS item, u.code AS unit,
             (-SUM(m.base_quantity_delta))::numeric(14,4)::text AS quantity,
             SUM(m.total_cost)::numeric(14,4)::text AS lot_value,
             SUM(m.cost_difference)::numeric(14,4)::text AS difference
      FROM inventory_lot_movements m
      JOIN inventory_lots l ON l.id = m.lot_id
      JOIN inventory_items i ON i.id = l.inventory_item_id
      JOIN units_of_measure u ON u.id = i.base_unit_id
      WHERE m.cost_difference IS NOT NULL
        AND l.location_id = ${filters.locationId}
        AND l.received_on BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY l.received_on, l.lot_number, i.name, u.code
      ORDER BY l.received_on, l.lot_number
    `,
  );
  const lots = await rowsOf<{
    item: string;
    lot_number: string;
    unit: string;
    expires_on: string | null;
    quantity: string;
    carrying: string | null;
    value: string | null;
  }>(
    context,
    sql`
      SELECT i.name AS item, l.lot_number, u.code AS unit, l.expires_on::text,
             l.quantity_remaining::numeric(14,4)::text AS quantity,
             l.carrying_unit_cost::text AS carrying, l.value_remaining::text AS value
      FROM inventory_lots l
      JOIN inventory_items i ON i.id = l.inventory_item_id
      JOIN units_of_measure u ON u.id = i.base_unit_id
      WHERE l.location_id = ${filters.locationId} AND i.costing_method = 'LOT' AND l.quantity_remaining > 0
      ORDER BY i.name, l.sequence_number
    `,
  );

  return [
    {
      key: "lot-cost-differences",
      title: "Negative stock cost differences",
      description:
        "Stock used beyond its lots was costed at the latest lot cost when sold. When a delivery covered it, the difference between that lot's value and the cost already posted is shown here, by the date the lot arrived. Sales keep the cost they were sent at.",
      columns: [
        { key: "receivedOn", label: "Lot arrived", kind: "date" },
        { key: "lotNumber", label: "Lot", kind: "text" },
        { key: "item", label: "Item", kind: "text" },
        { key: "unit", label: "Base unit", kind: "text" },
        { key: "quantity", label: "Quantity covered", kind: "quantity" },
        { key: "lotValue", label: "Lot value used", kind: "cost" },
        { key: "difference", label: "Difference", kind: "cost" },
      ],
      rows: differences.map((row) => ({
        receivedOn: row.received_on,
        lotNumber: row.lot_number,
        item: row.item,
        unit: row.unit,
        quantity: row.quantity,
        lotValue: row.lot_value,
        difference: row.difference,
      })),
    },
    {
      key: "stock-value-by-lot",
      title: "Stock value by lot (on hand now)",
      description: "Open lots of items costed by lot at this location today, at the cost each lot is carried at.",
      columns: [
        { key: "item", label: "Item", kind: "text" },
        { key: "lotNumber", label: "Lot", kind: "text" },
        { key: "unit", label: "Base unit", kind: "text" },
        { key: "expiresOn", label: "Use by", kind: "text" },
        { key: "quantity", label: "Left", kind: "quantity" },
        { key: "carrying", label: "Carried at", kind: "cost" },
        { key: "value", label: "Value", kind: "cost" },
      ],
      rows: lots.map((row) => ({
        item: row.item,
        lotNumber: row.lot_number,
        unit: row.unit,
        expiresOn: row.expires_on,
        quantity: row.quantity,
        carrying: row.carrying,
        value: row.value,
      })),
    },
  ];
}
