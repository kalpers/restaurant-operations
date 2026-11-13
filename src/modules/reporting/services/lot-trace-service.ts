import { sql } from "drizzle-orm";

import type { Database } from "@/db";
import { withReadOnlySnapshot, withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { AuthContext } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

import { reportToCsv } from "../rules/csv";
import type { ReportResult, ReportSection } from "../types";

// Phase 23 (policy 23, D14): trace one lot. Back to where it came from (each transfer up to
// the receipt and its purchase order), forward to every lot made from it at other locations,
// and to the orders that used it (order number, business date, item name from the order
// item's snapshot). No guest names or contact details. Read-only, from lot movements, the
// ledger and transfer history. Lots at locations where the user can't see inventory reports
// are counted but not shown; costs need inventory.cost.view at the lot's location.

type LotRow = {
  id: string;
  location_id: string;
  location_name: string;
  lot_number: string;
  item_name: string;
  supplier_lot_code: string | null;
  expires_on: string | null;
  received_on: string;
  origin: string;
  quantity_received: string;
  quantity_remaining: string;
  unit_cost: string | null;
  depth: number;
};

const rows = async <Row>(tx: DatabaseTransaction, query: ReturnType<typeof sql>) =>
  [...(await tx.execute<Record<string, unknown>>(query))] as Row[];

export async function traceLot(database: Database, auth: AuthContext, lotId: string): Promise<ReportResult> {
  return withReadOnlySnapshot(database, async (tx) => {
    const [lot] = await rows<{ location_id: string }>(tx, sql`SELECT location_id FROM inventory_lots WHERE id = ${lotId}`);
    const visible = new Set(
      auth.locations
        .filter((location) => location.permissions.includes("reports.view") && location.permissions.includes("reports.inventory"))
        .map((location) => location.locationId),
    );

    if (!lot || !visible.has(lot.location_id)) {
      // An unknown lot and one the user can't see look the same.
      throw lot ? new AuthorizationError() : new NotFoundError("lot");
    }

    const here = auth.locations.find((location) => location.locationId === lot.location_id)!;
    const showCost = here.permissions.includes("inventory.cost.view");
    // The lot, the lots it came from (negative depth) and those made from it (positive).
    const family = await rows<LotRow>(
      tx,
      sql`
        WITH RECURSIVE up AS (
          SELECT l.*, 0 AS depth FROM inventory_lots l WHERE l.id = ${lotId}
          UNION ALL
          SELECT p.*, up.depth - 1 FROM inventory_lots p JOIN up ON p.id = up.source_lot_id
        ), down AS (
          SELECT l.*, 0 AS depth FROM inventory_lots l WHERE l.id = ${lotId}
          UNION ALL
          SELECT c.*, down.depth + 1 FROM inventory_lots c JOIN down ON c.source_lot_id = down.id
        ), lots AS (
          SELECT * FROM up UNION SELECT * FROM down
        )
        SELECT lots.id, lots.location_id, loc.name AS location_name, lots.lot_number, i.name AS item_name,
               lots.supplier_lot_code, lots.expires_on::text, lots.received_on::text, lots.origin,
               lots.quantity_received::text, lots.quantity_remaining::text, lots.unit_cost::text, lots.depth
        FROM lots
        JOIN locations loc ON loc.id = lots.location_id
        JOIN inventory_items i ON i.id = lots.inventory_item_id
        ORDER BY lots.depth, lots.lot_number
      `,
    );
    const shown = family.filter((entry) => visible.has(entry.location_id));
    const hiddenCount = family.length - shown.length;
    const ids = shown.map((entry) => entry.id);
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const receipt = await rows<{ po_number: string; supplier: string; received_at: string }>(
      tx,
      sql`
        SELECT po.po_number, s.name AS supplier, to_char(r.received_at, 'YYYY-MM-DD') AS received_at
        FROM inventory_lot_movements m
        JOIN inventory_transactions t ON t.id = m.inventory_transaction_id AND t.transaction_type = 'RECEIVE'
        JOIN purchase_order_receipt_lines rl ON rl.inventory_transaction_id = t.id
        JOIN purchase_order_receipts r ON r.id = rl.receipt_id
        JOIN purchase_orders po ON po.id = r.purchase_order_id
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE m.lot_id IN (${idList}) AND m.base_quantity_delta > 0
      `,
    );
    const movements = await rows<{
      lot_number: string;
      location_name: string;
      business_date: string;
      type: string;
      quantity: string;
      reason: string | null;
      transfer_number: string | null;
    }>(
      tx,
      sql`
        SELECT l.lot_number, loc.name AS location_name, t.business_date::text, t.transaction_type AS type,
               m.base_quantity_delta::text AS quantity, t.reason_code AS reason, tr.transfer_number
        FROM inventory_lot_movements m
        JOIN inventory_lots l ON l.id = m.lot_id
        JOIN locations loc ON loc.id = l.location_id
        JOIN inventory_transactions t ON t.id = m.inventory_transaction_id
        LEFT JOIN inventory_transfers tr ON t.reference_type = 'INVENTORY_TRANSFER' AND tr.id = t.reference_id
        WHERE m.lot_id IN (${idList})
        ORDER BY t.sequence, m.created_at
      `,
    );
    const orders = await rows<{
      location_name: string;
      lot_number: string;
      order_number: number;
      business_date: string;
      item_name: string;
      quantity: string;
      remake: boolean;
    }>(
      tx,
      sql`
        SELECT loc.name AS location_name, l.lot_number, o.order_number, o.business_date::text,
               oi.menu_item_name_snapshot AS item_name, (-sum(m.base_quantity_delta))::numeric(14,4)::text AS quantity,
               (t.reference_type = 'KITCHEN_REMAKE') AS remake
        FROM inventory_lot_movements m
        JOIN inventory_lots l ON l.id = m.lot_id
        JOIN locations loc ON loc.id = l.location_id
        JOIN inventory_transactions t ON t.id = m.inventory_transaction_id AND t.transaction_type = 'CONSUME'
        LEFT JOIN kitchen_remakes kr ON t.reference_type = 'KITCHEN_REMAKE' AND kr.id = t.reference_id
        JOIN order_items oi ON oi.id = CASE WHEN t.reference_type = 'ORDER_ITEM' THEN t.reference_id ELSE kr.order_item_id END
        JOIN orders o ON o.id = oi.order_id
        WHERE m.lot_id IN (${idList})
        GROUP BY loc.name, l.lot_number, o.order_number, o.business_date, oi.id, oi.menu_item_name_snapshot, t.reference_type
        HAVING sum(m.base_quantity_delta) < 0
        ORDER BY o.business_date, o.order_number
      `,
    );
    const subject = shown.find((entry) => entry.depth === 0)!;
    const relation = (depth: number) => (depth < 0 ? "Came from" : depth > 0 ? "Sent on as" : "This lot");
    const sections: ReportSection[] = [
      {
        key: "lots",
        title: "Lot and where it went",
        description: receipt[0]
          ? `Received from ${receipt[0].supplier} on purchase order ${receipt[0].po_number} (${receipt[0].received_at}).`
          : "Not received on a purchase order (opening, found or transferred stock).",
        columns: [
          { key: "relation", label: "", kind: "text" },
          { key: "location", label: "Location", kind: "text" },
          { key: "lotNumber", label: "Lot", kind: "text" },
          { key: "item", label: "Item", kind: "text" },
          { key: "supplierLotCode", label: "Supplier lot", kind: "text" },
          { key: "expiresOn", label: "Use by", kind: "text" },
          { key: "receivedOn", label: "Received", kind: "date" },
          { key: "origin", label: "Origin", kind: "text" },
          { key: "received", label: "Quantity in", kind: "quantity" },
          { key: "remaining", label: "Left", kind: "quantity" },
          ...(showCost ? [{ key: "unitCost", label: "Cost per unit", kind: "cost" as const }] : []),
        ],
        rows: shown.map((entry) => ({
          relation: relation(entry.depth),
          location: entry.location_name,
          lotNumber: entry.lot_number,
          item: entry.item_name,
          supplierLotCode: entry.supplier_lot_code,
          expiresOn: entry.expires_on,
          receivedOn: entry.received_on,
          origin: entry.origin,
          received: entry.quantity_received,
          remaining: entry.quantity_remaining,
          ...(showCost ? { unitCost: entry.unit_cost } : {}),
        })),
      },
      {
        key: "movements",
        title: "Movements",
        columns: [
          { key: "businessDate", label: "Business date", kind: "date" },
          { key: "location", label: "Location", kind: "text" },
          { key: "lotNumber", label: "Lot", kind: "text" },
          { key: "type", label: "Movement", kind: "text" },
          { key: "quantity", label: "Quantity", kind: "quantity" },
          { key: "detail", label: "Detail", kind: "text" },
        ],
        rows: movements.map((row) => ({
          businessDate: row.business_date,
          location: row.location_name,
          lotNumber: row.lot_number,
          type: row.type,
          quantity: row.quantity,
          detail: row.transfer_number ?? row.reason,
        })),
      },
      {
        key: "orders",
        title: "Orders that used it",
        columns: [
          { key: "businessDate", label: "Business date", kind: "date" },
          { key: "location", label: "Location", kind: "text" },
          { key: "orderNumber", label: "Order", kind: "count" },
          { key: "item", label: "Item", kind: "text" },
          { key: "lotNumber", label: "Lot", kind: "text" },
          { key: "quantity", label: "Quantity", kind: "quantity" },
        ],
        rows: orders.map((row) => ({
          businessDate: row.business_date,
          location: row.location_name,
          orderNumber: row.order_number,
          item: row.remake ? `${row.item_name} (remake)` : row.item_name,
          lotNumber: row.lot_number,
          quantity: row.quantity,
        })),
      },
    ];

    return {
      area: "inventory",
      title: `Lot trace: ${subject.lot_number}`,
      location: { id: lot.location_id, code: subject.lot_number, name: subject.location_name },
      filters: { locationId: lot.location_id, from: subject.received_on, to: subject.received_on },
      notes: hiddenCount > 0 ? [`${hiddenCount} related lots are at locations whose inventory reports you can't see.`] : [],
      sections,
    };
  });
}

/** CSV of a lot trace. Needs `reports.export` at the lot's location; the export is audited. */
export async function exportLotTraceCsv(database: Database, auth: AuthContext, lotId: string) {
  const report = await traceLot(database, auth, lotId);
  const here = auth.locations.find((location) => location.locationId === report.location.id);

  if (!here?.permissions.includes("reports.export")) {
    throw new AuthorizationError();
  }

  await withTransaction(database, (transaction) =>
    recordAudit(
      transaction,
      { userId: auth.userId, organizationId: here.organizationId, locationId: here.locationId },
      { action: "reports.exported", entityId: lotId, details: { area: "inventory:lot-trace", from: report.filters.from, to: report.filters.to, rowCount: report.sections.reduce((total, section) => total + section.rows.length, 0) } },
    ),
  );

  return { fileName: `lot-trace_${report.location.code.replace(/[^A-Za-z0-9-]/g, "")}.csv`, csv: reportToCsv(report, report.sections) };
}
