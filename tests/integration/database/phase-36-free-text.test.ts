import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";

// Phase 36 (policy 3): every text column in the Phase 36 tables is either searched by the guest
// erase (staff-typed free text) or listed here as not free text. A new text column fails this
// test until someone decides which it is.

const SEARCHED_BY_ERASE = [
  "checklist_run_items.note",
  "checklist_run_items.skip_reason",
  "temperature_readings.corrective_action",
  "event_bookings.name",
  "event_bookings.notes",
  "event_bookings.menu_notes",
  "event_bookings.deposit_reference",
  "supplier_invoices.notes",
  "supplier_invoices.dispute_reason",
  "supplier_invoices.approval_reason",
  "supplier_invoices.void_reason",
  "event_bookings.cancel_reason",
];

const NOT_FREE_TEXT = [
  // Configuration written by managers, not about guests.
  "checklist_templates.name",
  "checklist_templates.kind",
  "checklist_template_items.text",
  "temperature_points.name",
  "temperature_points.kind",
  "temperature_points.unit",
  "menu_item_bundle_slots.name",
  // Copies of configuration, statuses and codes.
  "checklist_runs.kind",
  "checklist_runs.template_name_snapshot",
  "checklist_runs.status",
  "checklist_run_items.text_snapshot",
  "checklist_run_items.state",
  "temperature_readings.point_name_snapshot",
  "temperature_readings.unit",
  "event_bookings.status",
  "event_bookings.space_scope",
  "event_bookings.deposit_method",
  "supplier_invoices.invoice_number",
  "supplier_invoices.supplier_invoice_number",
  "supplier_invoices.status",
  "supplier_invoices.file_storage_key",
  "supplier_invoices.file_name",
  "supplier_invoices.file_content_type",
  "supplier_invoice_lines.line_kind",
  // Supplier charge descriptions (freight, tax, credits) on lines frozen at approval: labels for
  // the supplier's charges, card digits refused, not searched.
  "supplier_invoice_lines.description",
];

const PHASE_36_TABLES = [
  "checklist_templates",
  "checklist_template_items",
  "checklist_template_positions",
  "checklist_runs",
  "checklist_run_items",
  "temperature_points",
  "temperature_readings",
  "event_bookings",
  "event_booking_tables",
  "event_number_counters",
  "supplier_invoices",
  "supplier_invoice_lines",
  "supplier_invoice_variances",
  "menu_item_bundle_slots",
  "menu_item_bundle_slot_options",
];

describe("Phase 36 free text and the guest erase", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("classifies every text column of the Phase 36 tables", async () => {
    const rows = (await getDatabase().execute(sql`
      SELECT table_name || '.' || column_name AS column
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'text'
        AND table_name IN (${sql.join(PHASE_36_TABLES.map((name) => sql`${name}`), sql`, `)})
      ORDER BY 1
    `)) as unknown as { column: string }[];

    expect(rows.map((row) => row.column).sort()).toEqual([...SEARCHED_BY_ERASE, ...NOT_FREE_TEXT].sort());
  });
});
