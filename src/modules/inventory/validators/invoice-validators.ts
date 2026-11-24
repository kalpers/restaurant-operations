import { z } from "zod";

import { SUPPLIER_INVOICE_STATUSES } from "@/db/schema/supplier-invoices";

// Phase 36 part 4 shape only. Business rules are in the invoice service, and PostgreSQL has the
// final word.

const amount = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/);
const decimal4 = z.string().trim().regex(/^\d{1,10}(\.\d{1,4})?$/);

const line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ITEM"), receiptLineId: z.uuid(), quantity: decimal4, unitPrice: decimal4 }),
  z.object({
    kind: z.enum(["FREIGHT", "TAX", "OTHER", "CREDIT"]),
    description: z.string().trim().min(1).max(200),
    amount,
  }),
]);

const header = {
  supplierInvoiceNumber: z.string().trim().min(1).max(40),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date().nullable().optional(),
  statedTotal: amount,
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(line).min(1).max(200),
};

export const createInvoiceSchema = z.object({ ...header, supplierId: z.uuid() });

export const updateInvoiceSchema = z.object({ ...header, expectedVersion: z.int().positive() });

export const invoiceReasonSchema = z.object({ reason: z.string().max(500), expectedVersion: z.int().positive() });

export const approveInvoiceSchema = z.object({ reason: z.string().max(500).nullable().optional(), expectedVersion: z.int().positive() });

export const invoiceIdParamsSchema = z.object({ invoiceId: z.uuid() });

export const invoiceListQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  status: z.enum(SUPPLIER_INVOICE_STATUSES).optional(),
  supplierId: z.uuid().optional(),
});

export const invoiceableQuerySchema = z.object({ supplierId: z.uuid(), invoiceId: z.uuid().optional() });
