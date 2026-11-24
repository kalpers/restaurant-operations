import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation, readConstraintName } from "@/db/helpers/database-errors";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItems,
  locationSettings,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrderReceipts,
  purchaseOrders,
  supplierInvoiceLines,
  supplierInvoices,
  supplierInvoiceVariances,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import type { SupplierInvoiceLineKind, SupplierInvoiceStatus } from "@/db/schema/supplier-invoices";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { FileStorageService } from "@/infrastructure/storage/file-storage-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";
import { AuthorizationError, BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import {
  assertInvoiceEditable,
  assertInvoiceFileAcceptable,
  assertNoCardDigits,
  assertInvoiceTransition,
  assertTotalsMatch,
  chargeLineAmount,
  formatInvoiceNumber,
  itemLineAmount,
  lineVariance,
  linesTotal,
  reasonText,
  supplierDocumentNumber,
  type LineVariance,
  type Tolerance,
} from "../rules/invoice-rules";
import { assertPermission, canSeeCost } from "./access";

// Phase 36 part 4 (policy 8): supplier invoices matched against receipts. Record only: an invoice
// never posts to the ledger, changes a balance, average cost, supplier cost history or a
// supplier item's last cost. Variances are worked out on read until approval stores them.

type InvoiceRow = typeof supplierInvoices.$inferSelect;
type LineRow = typeof supplierInvoiceLines.$inferSelect;

export type ItemLineInput = { kind: "ITEM"; receiptLineId: string; quantity: string; unitPrice: string };
export type ChargeLineInput = { kind: "FREIGHT" | "TAX" | "OTHER" | "CREDIT"; description: string; amount: string };
export type InvoiceLineInput = ItemLineInput | ChargeLineInput;

export type InvoiceInput = {
  supplierId: string;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  statedTotal: string;
  notes?: string | null;
  lines: InvoiceLineInput[];
};

export type ReceiptLineFacts = {
  receiptLineId: string;
  receiptId: string;
  receivedOn: string;
  poNumber: string;
  supplierReference: string | null;
  itemName: string;
  unitName: string;
  receivedQuantity: string;
  receiptUnitCost: string;
  orderedUnitPrice: string;
};

export type InvoiceLineView = {
  id: string;
  kind: SupplierInvoiceLineKind;
  description: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  receipt: ReceiptLineFacts | null;
  /** Item lines: live while editable, as stored once approved. */
  variance: LineVariance | null;
};

export type InvoiceView = {
  id: string;
  invoiceNumber: string;
  supplier: { id: string; name: string };
  supplierInvoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  statedTotal: string | null;
  linesTotal: string | null;
  totalsMatch: boolean | null;
  notes: string | null;
  status: SupplierInvoiceStatus;
  disputeReason: string | null;
  approvalReason: string | null;
  voidReason: string | null;
  file: { name: string; contentType: string; sizeBytes: number } | null;
  version: number;
  lines: InvoiceLineView[];
  /** Item lines outside tolerance (or with a quantity mismatch). */
  linesNeedingReason: number;
};

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

async function readTolerance(executor: DatabaseExecutor, locationId: string): Promise<Tolerance> {
  const [row] = await executor
    .select({ percent: locationSettings.invoicePriceTolerancePercent, amount: locationSettings.invoicePriceToleranceAmount })
    .from(locationSettings)
    .where(eq(locationSettings.locationId, locationId));

  return row ?? { percent: "2.00", amount: "0.5000" };
}

async function receiptLineFacts(executor: DatabaseExecutor, receiptLineIds: readonly string[]): Promise<Map<string, ReceiptLineFacts>> {
  if (receiptLineIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      receiptLineId: purchaseOrderReceiptLines.id,
      receiptId: purchaseOrderReceipts.id,
      receivedOn: purchaseOrderReceipts.businessDate,
      poNumber: purchaseOrders.poNumber,
      supplierReference: purchaseOrderReceipts.supplierReference,
      itemName: inventoryItems.name,
      unitName: unitsOfMeasure.name,
      receivedQuantity: purchaseOrderReceiptLines.receivedQuantity,
      receiptUnitCost: purchaseOrderReceiptLines.actualUnitCost,
      orderedUnitPrice: purchaseOrderLines.unitPrice,
    })
    .from(purchaseOrderReceiptLines)
    .innerJoin(purchaseOrderReceipts, eq(purchaseOrderReceipts.id, purchaseOrderReceiptLines.receiptId))
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseOrderReceiptLines.purchaseOrderLineId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderReceipts.purchaseOrderId))
    .innerJoin(inventoryItems, eq(inventoryItems.id, purchaseOrderLines.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, purchaseOrderReceiptLines.purchaseUnitId))
    .where(inArray(purchaseOrderReceiptLines.id, [...receiptLineIds]));

  return new Map(rows.map((row) => [row.receiptLineId, row]));
}

async function viewOf(executor: DatabaseExecutor, actor: Actor, invoice: InvoiceRow): Promise<InvoiceView> {
  const showMoney = canSeeCost(actor);
  const [supplier] = await executor.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, invoice.supplierId));
  const lines = await executor
    .select()
    .from(supplierInvoiceLines)
    .where(eq(supplierInvoiceLines.invoiceId, invoice.id))
    .orderBy(asc(supplierInvoiceLines.sortOrder));
  const facts = await receiptLineFacts(
    executor,
    lines.map((line) => line.receiptLineId).filter((id): id is string => id !== null),
  );
  const stored = new Map(
    (await executor.select().from(supplierInvoiceVariances).where(eq(supplierInvoiceVariances.invoiceId, invoice.id))).map((row) => [
      row.invoiceLineId,
      row,
    ]),
  );
  const tolerance = await readTolerance(executor, invoice.locationId);
  const variances = new Map<string, LineVariance>();

  for (const line of lines) {
    const receipt = line.receiptLineId ? facts.get(line.receiptLineId) : undefined;

    if (!receipt || line.quantity === null || line.unitPrice === null) {
      continue;
    }

    const kept = stored.get(line.id);

    variances.set(
      line.id,
      kept
        ? {
            quantityVariance: kept.quantityVariance,
            priceVariance: kept.priceVariance,
            amountVariance: kept.amountVariance,
            pricePercent: kept.pricePercent,
            priceWithinTolerance: kept.priceWithinTolerance,
            quantityMatches: toScale(kept.quantityVariance, 4) === "0.0000",
            withinTolerance: kept.withinTolerance,
          }
        : lineVariance(
            {
              receivedQuantity: receipt.receivedQuantity,
              invoicedQuantity: line.quantity,
              receiptUnitCost: receipt.receiptUnitCost,
              orderedUnitPrice: receipt.orderedUnitPrice,
              invoicedUnitPrice: line.unitPrice,
              amount: line.amount,
            },
            tolerance,
          ),
    );
  }

  const total = linesTotal(lines.map((line) => line.amount));
  const hide = <T,>(value: T) => (showMoney ? value : null);

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    supplier: supplier!,
    supplierInvoiceNumber: invoice.supplierInvoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    statedTotal: hide(invoice.statedTotal),
    linesTotal: hide(total),
    totalsMatch: hide(toScale(total, 2) === toScale(invoice.statedTotal, 2)),
    notes: invoice.notes,
    status: invoice.status as SupplierInvoiceStatus,
    disputeReason: invoice.disputeReason,
    approvalReason: invoice.approvalReason,
    voidReason: invoice.voidReason,
    file:
      invoice.fileStorageKey && invoice.fileName && invoice.fileContentType && invoice.fileSizeBytes
        ? { name: invoice.fileName, contentType: invoice.fileContentType, sizeBytes: invoice.fileSizeBytes }
        : null,
    version: invoice.version,
    lines: lines.map((line) => {
      const receipt = line.receiptLineId ? (facts.get(line.receiptLineId) ?? null) : null;

      return {
        id: line.id,
        kind: line.lineKind as SupplierInvoiceLineKind,
        description: line.description,
        quantity: line.quantity,
        unitPrice: hide(line.unitPrice),
        amount: hide(line.amount),
        receipt: receipt && !showMoney ? { ...receipt, receiptUnitCost: "", orderedUnitPrice: "" } : receipt,
        variance: hide(variances.get(line.id) ?? null),
      };
    }),
    linesNeedingReason: [...variances.values()].filter((variance) => !variance.withinTolerance).length,
  };
}

// ------------------------------------------------------------------------------ Reading

export async function listInvoices(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: { from: string; to: string; status?: SupplierInvoiceStatus | null; supplierId?: string | null },
): Promise<Omit<InvoiceView, "lines">[]> {
  assertPermission(actor, "purchasing.view");

  const rows = await executor
    .select()
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.locationId, actor.locationId),
        gte(supplierInvoices.invoiceDate, filter.from),
        lte(supplierInvoices.invoiceDate, filter.to),
        filter.status ? eq(supplierInvoices.status, filter.status) : undefined,
        filter.supplierId ? eq(supplierInvoices.supplierId, filter.supplierId) : undefined,
      ),
    )
    .orderBy(desc(supplierInvoices.invoiceDate), desc(supplierInvoices.sequenceNumber))
    .limit(500);
  const views = await Promise.all(rows.map((row) => viewOf(executor, actor, row)));

  return views.map((view) => {
    const summary: Partial<InvoiceView> = { ...view };

    delete summary.lines;

    return summary as Omit<InvoiceView, "lines">;
  });
}

async function findInvoice(executor: DatabaseExecutor, actor: Actor, invoiceId: string): Promise<InvoiceRow> {
  const [row] = await executor
    .select()
    .from(supplierInvoices)
    .where(and(eq(supplierInvoices.id, invoiceId), eq(supplierInvoices.locationId, actor.locationId)));

  if (!row) {
    throw new NotFoundError("supplier invoice");
  }

  return row;
}

export async function getInvoice(executor: DatabaseExecutor, actor: Actor, invoiceId: string): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.view");

  return viewOf(executor, actor, await findInvoice(executor, actor, invoiceId));
}

/**
 * Policy 8: the supplier's receipt lines here that no live invoice holds yet (or that the given
 * invoice holds), newest first, for choosing an invoice's item lines.
 */
export async function listInvoiceableReceiptLines(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { supplierId: string; invoiceId?: string | null },
): Promise<ReceiptLineFacts[]> {
  assertPermission(actor, "purchasing.invoices.record");

  const taken = executor
    .select({ id: supplierInvoiceLines.receiptLineId })
    .from(supplierInvoiceLines)
    .where(
      and(
        eq(supplierInvoiceLines.holdsReceiptLine, true),
        sql`${supplierInvoiceLines.receiptLineId} IS NOT NULL`,
        input.invoiceId ? ne(supplierInvoiceLines.invoiceId, input.invoiceId) : undefined,
      ),
    );
  const rows = await executor
    .select({ id: purchaseOrderReceiptLines.id })
    .from(purchaseOrderReceiptLines)
    .innerJoin(purchaseOrderReceipts, eq(purchaseOrderReceipts.id, purchaseOrderReceiptLines.receiptId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderReceipts.purchaseOrderId))
    .where(
      and(
        eq(purchaseOrderReceipts.locationId, actor.locationId),
        eq(purchaseOrders.supplierId, input.supplierId),
        sql`${purchaseOrderReceiptLines.id} NOT IN (${taken})`,
      ),
    )
    .orderBy(desc(purchaseOrderReceipts.receivedAt))
    .limit(300);
  const facts = await receiptLineFacts(executor, rows.map((row) => row.id));

  return rows.map((row) => facts.get(row.id)!).filter(Boolean);
}

// ------------------------------------------------------------------------------ Writing

/** Entering and approving invoices means typing and reading prices, which are costs. */
function assertCostView(actor: Actor) {
  if (!canSeeCost(actor)) {
    throw new AuthorizationError();
  }
}

function lineRows(invoiceId: string, lines: readonly InvoiceLineInput[]) {
  if (lines.length === 0) {
    throw new BusinessRuleError("INVOICE_LINES_REQUIRED", "Add at least one line.");
  }

  const seen = new Set<string>();

  return lines.map((line, index) => {
    if (line.kind === "ITEM") {
      if (seen.has(line.receiptLineId)) {
        throw new BusinessRuleError("RECEIPT_LINE_TWICE", "A received line is invoiced once.");
      }

      seen.add(line.receiptLineId);

      const quantity = toScale(line.quantity, 4);
      const unitPrice = toScale(line.unitPrice, 4);

      return {
        invoiceId,
        lineKind: "ITEM",
        receiptLineId: line.receiptLineId,
        quantity,
        unitPrice,
        amount: itemLineAmount(quantity, unitPrice),
        sortOrder: (index + 1) * 10,
      };
    }

    const description = line.description.trim();

    assertNoCardDigits(description);

    return {
      invoiceId,
      lineKind: line.kind,
      description,
      amount: chargeLineAmount(line.kind, line.amount),
      sortOrder: (index + 1) * 10,
    };
  });
}

/** Writes the lines, mapping a receipt line already held by a live invoice to a clear refusal. */
async function writeLines(transaction: DatabaseTransaction, invoiceId: string, lines: readonly InvoiceLineInput[]) {
  const rows = lineRows(invoiceId, lines);

  await transaction.delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, invoiceId));

  try {
    await transaction.insert(supplierInvoiceLines).values(rows);
  } catch (error) {
    if (isUniqueViolation(error) && readConstraintName(error) === "supplier_invoice_lines_receipt_line_unique") {
      throw new ConflictError("RECEIPT_LINE_INVOICED", "A received line is already on another invoice. Void that one first.");
    }

    if (readConstraintName(error) === "supplier_invoice_lines_receipt_matches") {
      throw new BusinessRuleError("RECEIPT_LINE_OTHER_SUPPLIER", "Each item line is a receipt from this supplier, here.");
    }

    throw error;
  }
}

async function assertSupplier(executor: DatabaseExecutor, actor: Actor, supplierId: string) {
  const [supplier] = await executor
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.organizationId, actor.organizationId)));

  if (!supplier) {
    throw new NotFoundError("supplier");
  }
}

function headerFields(input: InvoiceInput) {
  const notes = blankToNull(input.notes);

  assertNoCardDigits(notes);

  return {
    supplierInvoiceNumber: supplierDocumentNumber(input.supplierInvoiceNumber),
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate ?? null,
    statedTotal: toScale(input.statedTotal, 2),
    notes,
  };
}

function mapDuplicateNumber(error: unknown): never {
  if (isUniqueViolation(error) && readConstraintName(error) === "supplier_invoices_supplier_document_unique") {
    throw new ConflictError("INVOICE_NUMBER_TAKEN", "This supplier's invoice number is already entered here.");
  }

  throw error;
}

/** Policy 8: enters an invoice as a draft, numbered per location. */
export async function createInvoice(database: Database, actor: Actor, input: InvoiceInput): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.record");
  assertCostView(actor);

  const header = headerFields(input);

  const invoiceId = await withTransaction(database, async (transaction) => {
    await assertSupplier(transaction, actor, input.supplierId);
    // Numbers are allocated one at a time per location.
    await transaction
      .select({ locationId: locationSettings.locationId })
      .from(locationSettings)
      .where(eq(locationSettings.locationId, actor.locationId))
      .for("update");

    const [last] = await transaction
      .select({ value: sql<number | null>`max(${supplierInvoices.sequenceNumber})` })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.locationId, actor.locationId));
    const sequenceNumber = Number(last?.value ?? 0) + 1;
    const [row] = await transaction
      .insert(supplierInvoices)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        supplierId: input.supplierId,
        sequenceNumber,
        invoiceNumber: formatInvoiceNumber(sequenceNumber),
        ...header,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning({ id: supplierInvoices.id })
      .catch(mapDuplicateNumber);

    await writeLines(transaction, row!.id, input.lines);

    return row!.id;
  });

  return getInvoice(database, actor, invoiceId);
}

async function lockInvoice(transaction: DatabaseTransaction, actor: Actor, invoiceId: string, expectedVersion: number): Promise<InvoiceRow> {
  const [row] = await transaction
    .select()
    .from(supplierInvoices)
    .where(and(eq(supplierInvoices.id, invoiceId), eq(supplierInvoices.locationId, actor.locationId)))
    .for("update");

  if (!row) {
    throw new NotFoundError("supplier invoice");
  }

  if (row.version !== expectedVersion) {
    throw new ConflictError("CONCURRENCY_CONFLICT", "This invoice was changed by someone else. Reload and try again.");
  }

  return row;
}

async function bump(transaction: DatabaseTransaction, actor: Actor, invoice: InvoiceRow, changes: Partial<InvoiceRow>) {
  assertVersionMatched(
    await transaction
      .update(supplierInvoices)
      .set({ ...changes, updatedByUserId: actor.userId, version: nextVersion(supplierInvoices.version) })
      .where(and(eq(supplierInvoices.id, invoice.id), eq(supplierInvoices.version, invoice.version)))
      .returning({ id: supplierInvoices.id }),
    { type: "supplier invoice", id: invoice.id },
  );
}

/** Policy 8: replaces a draft or disputed invoice's header and lines. */
export async function updateInvoice(
  database: Database,
  actor: Actor,
  invoiceId: string,
  input: Omit<InvoiceInput, "supplierId"> & { expectedVersion: number },
): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.record");
  assertCostView(actor);

  const header = headerFields({ ...input, supplierId: "" });

  await withTransaction(database, async (transaction) => {
    const invoice = await lockInvoice(transaction, actor, invoiceId, input.expectedVersion);

    assertInvoiceEditable(invoice.status as SupplierInvoiceStatus);
    await bump(transaction, actor, invoice, header).catch(mapDuplicateNumber);
    await writeLines(transaction, invoice.id, input.lines);
  });

  return getInvoice(database, actor, invoiceId);
}

/** Policy 8: marks an invoice disputed, with a reason, until the supplier sorts it out. */
export async function disputeInvoice(
  database: Database,
  actor: Actor,
  invoiceId: string,
  input: { reason: string; expectedVersion: number },
): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.approve");
  assertCostView(actor);

  const reason = reasonText(input.reason, "REASON_REQUIRED", "Say what is disputed, in up to 500 characters.");

  assertNoCardDigits(reason);

  await withTransaction(database, async (transaction) => {
    const invoice = await lockInvoice(transaction, actor, invoiceId, input.expectedVersion);

    assertInvoiceTransition(invoice.status as SupplierInvoiceStatus, "DISPUTED");
    await bump(transaction, actor, invoice, { status: "DISPUTED", disputeReason: reason, disputedAt: new Date(), disputedByUserId: actor.userId });
    await recordAudit(transaction, actor, {
      action: "inventory.invoice-disputed",
      entityId: invoice.id,
      details: { invoiceNumber: invoice.invoiceNumber, supplierId: invoice.supplierId, reasonLength: reason.length },
    });
  });

  return getInvoice(database, actor, invoiceId);
}

/**
 * Policy 8: approves an invoice whose lines add up to its stated total. Lines outside tolerance
 * (or with a quantity mismatch) need a reason. Each item line's variances are stored as they
 * are now. Nothing is posted to inventory.
 */
export async function approveInvoice(
  database: Database,
  actor: Actor,
  invoiceId: string,
  input: { reason?: string | null; expectedVersion: number },
): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.approve");
  assertCostView(actor);

  await withTransaction(database, async (transaction) => {
    const invoice = await lockInvoice(transaction, actor, invoiceId, input.expectedVersion);

    assertInvoiceTransition(invoice.status as SupplierInvoiceStatus, "APPROVED");

    const lines: LineRow[] = await transaction.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, invoice.id));

    assertTotalsMatch(lines.map((line) => line.amount), invoice.statedTotal);

    const tolerance = await readTolerance(transaction, invoice.locationId);
    const facts = await receiptLineFacts(
      transaction,
      lines.map((line) => line.receiptLineId).filter((id): id is string => id !== null),
    );
    const computed = lines
      .filter((line) => line.lineKind === "ITEM")
      .map((line) => {
        const receipt = facts.get(line.receiptLineId!)!;

        return {
          line,
          receipt,
          variance: lineVariance(
            {
              receivedQuantity: receipt.receivedQuantity,
              invoicedQuantity: line.quantity!,
              receiptUnitCost: receipt.receiptUnitCost,
              orderedUnitPrice: receipt.orderedUnitPrice,
              invoicedUnitPrice: line.unitPrice!,
              amount: line.amount,
            },
            tolerance,
          ),
        };
      });
    const outside = computed.filter((entry) => !entry.variance.withinTolerance).length;
    const reason = blankToNull(input.reason);

    if (outside > 0 && !reason) {
      throw new BusinessRuleError(
        "INVOICE_VARIANCE_REASON_REQUIRED",
        `${outside === 1 ? "One line is" : `${outside} lines are`} outside tolerance. Give a reason to approve anyway.`,
      );
    }

    if (reason) {
      reasonText(reason, "REASON_REQUIRED", "Keep the reason to 500 characters.");
      assertNoCardDigits(reason);
    }

    if (computed.length > 0) {
      await transaction.insert(supplierInvoiceVariances).values(
        computed.map(({ line, receipt, variance }) => ({
          invoiceId: invoice.id,
          invoiceLineId: line.id,
          receivedQuantity: receipt.receivedQuantity,
          invoicedQuantity: line.quantity!,
          receiptUnitCost: receipt.receiptUnitCost,
          orderedUnitPrice: receipt.orderedUnitPrice,
          invoicedUnitPrice: line.unitPrice!,
          quantityVariance: variance.quantityVariance,
          priceVariance: variance.priceVariance,
          amountVariance: variance.amountVariance,
          pricePercent: variance.pricePercent,
          priceWithinTolerance: variance.priceWithinTolerance,
          withinTolerance: variance.withinTolerance,
        })),
      );
    }

    await bump(transaction, actor, invoice, {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByUserId: actor.userId,
      approvalReason: outside > 0 ? reason : null,
    });
    await recordAudit(transaction, actor, {
      action: "inventory.invoice-approved",
      entityId: invoice.id,
      details: {
        invoiceNumber: invoice.invoiceNumber,
        supplierId: invoice.supplierId,
        statedTotal: invoice.statedTotal,
        lineCount: lines.length,
        linesOutsideTolerance: outside,
      },
    });
  });

  return getInvoice(database, actor, invoiceId);
}

/** Policy 8: voids an invoice with a reason; its receipt lines can then go on another invoice. */
export async function voidInvoice(
  database: Database,
  actor: Actor,
  invoiceId: string,
  input: { reason: string; expectedVersion: number },
): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.approve");
  assertCostView(actor);

  const reason = reasonText(input.reason, "REASON_REQUIRED", "Say why the invoice is voided, in up to 500 characters.");

  assertNoCardDigits(reason);

  await withTransaction(database, async (transaction) => {
    const invoice = await lockInvoice(transaction, actor, invoiceId, input.expectedVersion);

    assertInvoiceTransition(invoice.status as SupplierInvoiceStatus, "VOIDED");
    await bump(transaction, actor, invoice, { status: "VOIDED", voidedAt: new Date(), voidedByUserId: actor.userId, voidReason: reason });
    await transaction.update(supplierInvoiceLines).set({ holdsReceiptLine: false }).where(eq(supplierInvoiceLines.invoiceId, invoice.id));
    await recordAudit(transaction, actor, {
      action: "inventory.invoice-voided",
      entityId: invoice.id,
      details: { invoiceNumber: invoice.invoiceNumber, supplierId: invoice.supplierId, fromStatus: invoice.status, reasonLength: reason.length },
    });
  });

  return getInvoice(database, actor, invoiceId);
}

// ------------------------------------------------------------------------------ Scanned copy

export const INVOICE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Policy 8: records a stored scanned copy on an invoice (the caller stores the bytes first,
 * outside any transaction). Returns the key it replaced, for the caller to remove after commit.
 */
export async function recordInvoiceFile(
  database: Database,
  actor: Actor,
  invoiceId: string,
  input: { storageKey: string; fileName: string; contentType: string; sizeBytes: number; expectedVersion: number },
): Promise<{ replacedKey: string | null; invoice: InvoiceView }> {
  assertPermission(actor, "purchasing.invoices.record");
  assertCostView(actor);

  const replacedKey = await withTransaction(database, async (transaction) => {
    const invoice = await lockInvoice(transaction, actor, invoiceId, input.expectedVersion);

    assertInvoiceEditable(invoice.status as SupplierInvoiceStatus);
    await bump(transaction, actor, invoice, {
      fileStorageKey: input.storageKey,
      fileName: input.fileName.slice(0, 200),
      fileContentType: input.contentType,
      fileSizeBytes: input.sizeBytes,
    });

    return invoice.fileStorageKey;
  });

  return { replacedKey, invoice: await getInvoice(database, actor, invoiceId) };
}

/** The stored copy's key and metadata, for download by `purchasing.view` holders. */
export async function readInvoiceFileRef(executor: DatabaseExecutor, actor: Actor, invoiceId: string) {
  assertPermission(actor, "purchasing.view");

  const invoice = await findInvoice(executor, actor, invoiceId);

  if (!invoice.fileStorageKey || !invoice.fileName || !invoice.fileContentType) {
    throw new NotFoundError("invoice file");
  }

  return { storageKey: invoice.fileStorageKey, fileName: invoice.fileName, contentType: invoice.fileContentType };
}

/**
 * Policy 8: stores a scanned copy (PDF, PNG or JPEG, up to 10 MB) outside PostgreSQL before any
 * transaction, records it on the invoice, and removes the bytes if that fails. A replaced copy
 * is removed after commit.
 */
export async function uploadInvoiceFile(
  database: Database,
  storage: FileStorageService,
  actor: Actor,
  invoiceId: string,
  input: { bytes: Uint8Array; mimeType: string; fileName: string; expectedVersion: number },
): Promise<InvoiceView> {
  assertPermission(actor, "purchasing.invoices.record");
  assertCostView(actor);

  const mimeType = assertInvoiceFileAcceptable({ bytes: input.bytes, mimeType: input.mimeType, maxBytes: INVOICE_FILE_MAX_BYTES });
  await findInvoice(database, actor, invoiceId);

  const storageKey = await storage.put(input.bytes);

  try {
    const { replacedKey, invoice } = await recordInvoiceFile(database, actor, invoiceId, {
      storageKey,
      fileName: input.fileName,
      contentType: mimeType,
      sizeBytes: input.bytes.length,
      expectedVersion: input.expectedVersion,
    });

    if (replacedKey) {
      await storage.remove(replacedKey).catch(() => undefined);
    }

    return invoice;
  } catch (error) {
    await storage.remove(storageKey).catch(() => undefined);

    throw error;
  }
}

/** The stored copy, for download. Every download is authorized; there is no public URL. */
export async function readInvoiceFile(executor: DatabaseExecutor, storage: FileStorageService, actor: Actor, invoiceId: string) {
  assertPermission(actor, "purchasing.view");

  const ref = await readInvoiceFileRef(executor, actor, invoiceId);

  return { bytes: await storage.get(ref.storageKey), fileName: ref.fileName, contentType: ref.contentType };
}
