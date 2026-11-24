import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { cost, money, quantity } from "../helpers/numeric";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { purchaseOrderReceiptLines, suppliers } from "./inventory";
import { locations, organizations } from "./organization";

// Phase 36 part 4, owned by Inventory (policy 8): supplier invoices matched against receipts. An
// invoice is a check on what was received: nothing here posts to the inventory ledger, changes a
// balance or average cost, or writes supplier cost history. Each item line names one receipt
// line, and a receipt line is on at most one non-voided invoice. Approval stores each item
// line's variances as they were (append-only).

export const SUPPLIER_INVOICE_STATUSES = ["DRAFT", "DISPUTED", "APPROVED", "VOIDED"] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

export const SUPPLIER_INVOICE_LINE_KINDS = ["ITEM", "FREIGHT", "TAX", "OTHER", "CREDIT"] as const;
export type SupplierInvoiceLineKind = (typeof SUPPLIER_INVOICE_LINE_KINDS)[number];

export const SUPPLIER_INVOICE_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    sequenceNumber: integer("sequence_number").notNull(),
    /** `INV-000123`, per location. */
    invoiceNumber: text("invoice_number").notNull(),
    /** The supplier's own document number, as printed. */
    supplierInvoiceNumber: text("supplier_invoice_number").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),
    statedTotal: money("stated_total").notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("DRAFT"),
    disputeReason: text("dispute_reason"),
    disputedAt: timestamptz("disputed_at"),
    disputedByUserId: uuid("disputed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamptz("approved_at"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** Why an invoice outside tolerance was approved anyway. */
    approvalReason: text("approval_reason"),
    voidedAt: timestamptz("voided_at"),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidReason: text("void_reason"),
    /** Policy 8: an optional scanned copy, stored outside PostgreSQL. */
    fileStorageKey: text("file_storage_key"),
    fileName: text("file_name"),
    fileContentType: text("file_content_type"),
    fileSizeBytes: integer("file_size_bytes"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "supplier_invoices_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("supplier_invoices_location_sequence_unique").on(table.locationId, table.sequenceNumber),
    unique("supplier_invoices_location_number_unique").on(table.locationId, table.invoiceNumber),
    unique("supplier_invoices_file_key_unique").on(table.fileStorageKey),
    // Policy 8: one live invoice per supplier document number at a location.
    uniqueIndex("supplier_invoices_supplier_document_unique")
      .on(table.locationId, table.supplierId, sql`upper(${table.supplierInvoiceNumber})`)
      .where(sql`${table.status} <> 'VOIDED'`),
    check("supplier_invoices_sequence_positive", sql`${table.sequenceNumber} > 0`),
    check("supplier_invoices_number_format", sql`${table.invoiceNumber} ~ '^INV-[0-9]{6,}$'`),
    check("supplier_invoices_supplier_number_valid", sql`${table.supplierInvoiceNumber} ~ '^[A-Za-z0-9/-]{1,40}$'`),
    check("supplier_invoices_status_valid", sql`${table.status} IN (${inList(SUPPLIER_INVOICE_STATUSES)})`),
    check("supplier_invoices_due_after_invoice", sql`${table.dueDate} IS NULL OR ${table.dueDate} >= ${table.invoiceDate}`),
    check("supplier_invoices_notes_length", sql`${table.notes} IS NULL OR char_length(${table.notes}) BETWEEN 1 AND 2000`),
    check(
      "supplier_invoices_no_card_digits",
      sql`coalesce(${table.notes}, '') !~ '[0-9]{13,}' AND coalesce(${table.disputeReason}, '') !~ '[0-9]{13,}'
        AND coalesce(${table.approvalReason}, '') !~ '[0-9]{13,}' AND coalesce(${table.voidReason}, '') !~ '[0-9]{13,}'`,
    ),
    check(
      "supplier_invoices_dispute_recorded",
      sql`(${table.disputedAt} IS NULL AND ${table.disputedByUserId} IS NULL AND ${table.disputeReason} IS NULL)
        OR (${table.disputedAt} IS NOT NULL AND ${table.disputedByUserId} IS NOT NULL AND char_length(${table.disputeReason}) BETWEEN 1 AND 500)`,
    ),
    check(
      "supplier_invoices_approval_recorded",
      sql`(${table.approvedAt} IS NULL) = (${table.approvedByUserId} IS NULL)
        AND (${table.status} <> 'APPROVED' OR ${table.approvedAt} IS NOT NULL)
        AND (${table.approvalReason} IS NULL OR char_length(${table.approvalReason}) BETWEEN 1 AND 500)`,
    ),
    check(
      "supplier_invoices_void_recorded",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL OR (${table.voidedByUserId} IS NOT NULL AND char_length(${table.voidReason}) BETWEEN 1 AND 500))`,
    ),
    check(
      "supplier_invoices_file_recorded",
      sql`(${table.fileStorageKey} IS NULL AND ${table.fileName} IS NULL AND ${table.fileContentType} IS NULL AND ${table.fileSizeBytes} IS NULL)
        OR (${table.fileStorageKey} IS NOT NULL AND char_length(${table.fileName}) BETWEEN 1 AND 200
          AND ${table.fileContentType} IN (${inList(SUPPLIER_INVOICE_FILE_TYPES)}) AND ${table.fileSizeBytes} > 0)`,
    ),
    index("supplier_invoices_location_date_idx").on(table.locationId, table.invoiceDate),
    index("supplier_invoices_supplier_idx").on(table.supplierId),
  ],
);

export const supplierInvoiceLines = pgTable(
  "supplier_invoice_lines",
  {
    id: uuidPrimaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    lineKind: text("line_kind").notNull(),
    /** ITEM lines: the receipt line invoiced. */
    receiptLineId: uuid("receipt_line_id"),
    /** True while the invoice isn't voided: the receipt line is taken (one live invoice line each). */
    holdsReceiptLine: boolean("holds_receipt_line").notNull().default(true),
    description: text("description"),
    /** ITEM lines, in purchase units. */
    quantity: quantity("quantity"),
    /** ITEM lines, per purchase unit. */
    unitPrice: cost("unit_price"),
    amount: money("amount").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "supplier_invoice_lines_receipt_line_fk",
      columns: [table.receiptLineId],
      foreignColumns: [purchaseOrderReceiptLines.id],
    }).onDelete("restrict"),
    uniqueIndex("supplier_invoice_lines_receipt_line_unique")
      .on(table.receiptLineId)
      .where(sql`${table.holdsReceiptLine} AND ${table.receiptLineId} IS NOT NULL`),
    check("supplier_invoice_lines_kind_valid", sql`${table.lineKind} IN (${inList(SUPPLIER_INVOICE_LINE_KINDS)})`),
    check(
      "supplier_invoice_lines_shape",
      sql`(${table.lineKind} = 'ITEM' AND ${table.receiptLineId} IS NOT NULL AND ${table.quantity} > 0 AND ${table.unitPrice} >= 0
          AND ${table.amount} >= 0 AND ${table.description} IS NULL)
        OR (${table.lineKind} <> 'ITEM' AND ${table.receiptLineId} IS NULL AND ${table.quantity} IS NULL AND ${table.unitPrice} IS NULL
          AND char_length(${table.description}) BETWEEN 1 AND 200
          AND ((${table.lineKind} = 'CREDIT' AND ${table.amount} < 0) OR (${table.lineKind} <> 'CREDIT' AND ${table.amount} >= 0)))`,
    ),
    check("supplier_invoice_lines_no_card_digits", sql`coalesce(${table.description}, '') !~ '[0-9]{13,}'`),
    index("supplier_invoice_lines_invoice_idx").on(table.invoiceId, table.sortOrder),
  ],
);

/** Policy 8: each item line's variances as they were when the invoice was approved. Append-only. */
export const supplierInvoiceVariances = pgTable(
  "supplier_invoice_variances",
  {
    id: uuidPrimaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    invoiceLineId: uuid("invoice_line_id").notNull(),
    receivedQuantity: quantity("received_quantity").notNull(),
    invoicedQuantity: quantity("invoiced_quantity").notNull(),
    receiptUnitCost: cost("receipt_unit_cost").notNull(),
    orderedUnitPrice: cost("ordered_unit_price").notNull(),
    invoicedUnitPrice: cost("invoiced_unit_price").notNull(),
    /** Invoiced minus received, in purchase units. */
    quantityVariance: quantity("quantity_variance").notNull(),
    /** Invoiced unit price minus the receipt's unit cost. */
    priceVariance: cost("price_variance").notNull(),
    /** The line amount minus received quantity at the receipt's cost, to the cent. */
    amountVariance: money("amount_variance").notNull(),
    pricePercent: numeric("price_percent", { precision: 9, scale: 2, mode: "string" }),
    priceWithinTolerance: boolean("price_within_tolerance").notNull(),
    /** The price in tolerance and the quantity matching: nothing on the line needed a reason. */
    withinTolerance: boolean("within_tolerance").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "supplier_invoice_variances_line_fk",
      columns: [table.invoiceLineId],
      foreignColumns: [supplierInvoiceLines.id],
    }).onDelete("restrict"),
    unique("supplier_invoice_variances_line_unique").on(table.invoiceLineId),
    index("supplier_invoice_variances_invoice_idx").on(table.invoiceId),
  ],
);
