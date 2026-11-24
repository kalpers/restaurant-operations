import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import {
  auditEvents,
  inventoryBalances,
  inventoryTransactions,
  supplierInvoiceLines,
  supplierInvoices,
  supplierInvoiceVariances,
  supplierItemCostHistory,
  supplierItems,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  approveInvoice,
  createInvoice,
  disputeInvoice,
  getInvoice,
  listInvoiceableReceiptLines,
  updateInvoice,
  uploadInvoiceFile,
  voidInvoice,
  type InvoiceInput,
} from "@/modules/inventory/services/invoice-service";
import { addPurchaseOrderLine, createPurchaseOrder, submitPurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "@/modules/inventory/services/receiving-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { AppError } from "@/shared/errors/app-error";
import type { FileStorageService } from "@/infrastructure/storage/file-storage-service";

import { actorWith } from "../../fixtures/employee-fixtures";
import { createInventoryScenario, INVENTORY_ADMIN, stockedItem, supplierWith, type InventoryScenario } from "../../fixtures/inventory-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return readConstraintName(error) ?? (error as Error).message;
  }

  return undefined;
}

/** An in-memory store, to see what was put and removed. */
function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  let next = 0;
  const storage: FileStorageService = {
    put: async (bytes) => {
      const key = `key-${(next += 1)}`;

      files.set(key, bytes);

      return key;
    },
    get: async (key) => Buffer.from(files.get(key)!),
    remove: async (key) => {
      files.delete(key);
    },
  };

  return { storage, files };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

describe("supplier invoices (Phase 36 part 4)", () => {
  let scenario: InventoryScenario;
  let clerk: Actor;
  let approver: Actor;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
    clerk = await actorWith(database(), scenario, [...INVENTORY_ADMIN, "purchasing.invoices.record"]);
    approver = await actorWith(database(), scenario, [...INVENTORY_ADMIN, "purchasing.invoices.record", "purchasing.invoices.approve", "reports.view", "reports.inventory"]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** Ten cases of vodka at 300.00 ordered; `received` delivered at `cost`. */
  async function received(options: { received?: string; cost?: string | null } = {}) {
    const vodka = await stockedItem(database(), scenario.admin, {
      measurementType: "VOLUME",
      baseUnitId: scenario.units.ml,
      conversions: [
        { fromUnitId: scenario.units.case, toUnitId: scenario.units.bottle, factor: "12" },
        { fromUnitId: scenario.units.bottle, toUnitId: scenario.units.l, factor: "1" },
      ],
    });
    const {
      supplier,
      supplierItems: [caseItem],
    } = await supplierWith(database(), scenario.admin, [{ inventoryItemId: vodka.id, purchaseUnitId: scenario.units.case, lastUnitCost: "300.0000" }]);
    const order = await createPurchaseOrder(database(), scenario.admin, { supplierId: supplier.id, expectedAt: null, notes: null });
    const line = await addPurchaseOrderLine(database(), scenario.admin, order.id, {
      supplierItemId: caseItem!.id,
      orderedQuantity: "10",
      unitPrice: null,
      expectedVersion: order.version,
    });

    await submitPurchaseOrder(database(), scenario.admin, order.id, order.version + 1);
    await receivePurchaseOrder(database(), scenario.admin, order.id, {
      lines: [{ purchaseOrderLineId: line.id, receivedQuantity: options.received ?? "10", actualUnitCost: options.cost ?? null }],
      supplierReference: "DN-77",
      notes: null,
    });

    const [receiptLine] = await listInvoiceableReceiptLines(database(), clerk, { supplierId: supplier.id });

    return { vodka, supplier, caseItem: caseItem!, receiptLine: receiptLine! };
  }

  function invoice(setup: Awaited<ReturnType<typeof received>>, overrides: Partial<InvoiceInput> = {}): InvoiceInput {
    return {
      supplierId: setup.supplier.id,
      supplierInvoiceNumber: "A-1001",
      invoiceDate: "2026-11-20",
      dueDate: "2026-12-20",
      statedTotal: "3025.00",
      notes: null,
      lines: [
        { kind: "ITEM", receiptLineId: setup.receiptLine.receiptLineId, quantity: "10", unitPrice: "300" },
        { kind: "FREIGHT", description: "Delivery", amount: "25.00" },
      ],
      ...overrides,
    };
  }

  it("enters a draft against a receipt, numbered per location, with live variances", async () => {
    const setup = await received();
    const draft = await createInvoice(database(), clerk, invoice(setup));

    expect(draft).toMatchObject({
      invoiceNumber: expect.stringMatching(/^INV-\d{6}$/),
      status: "DRAFT",
      statedTotal: "3025.00",
      linesTotal: "3025.00",
      totalsMatch: true,
      linesNeedingReason: 0,
    });
    expect(draft.lines[0]).toMatchObject({ kind: "ITEM", amount: "3000.00", receipt: { poNumber: expect.stringMatching(/^PO-/) } });
    expect(draft.lines[0]!.variance).toMatchObject({ quantityVariance: "0.0000", priceVariance: "0.0000", withinTolerance: true });

    // The receipt line is now held, so it isn't offered again.
    expect(await listInvoiceableReceiptLines(database(), clerk, { supplierId: setup.supplier.id })).toEqual([]);
    expect(await codeOf(createInvoice(database(), clerk, invoice(setup, { supplierInvoiceNumber: "A-1002" })))).toBe("RECEIPT_LINE_INVOICED");
    expect(await codeOf(createInvoice(database(), clerk, invoice(setup, { lines: [{ kind: "OTHER", description: "x", amount: "1" }] })))).toBe(
      "INVOICE_NUMBER_TAKEN",
    );
  });

  it("approves within tolerance, storing variances, and changes no inventory cost", async () => {
    const setup = await received();
    const [balanceBefore] = await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, setup.vodka.id));
    const ledgerBefore = (await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, setup.vodka.id))).length;
    const historyBefore = (await database().select().from(supplierItemCostHistory).where(eq(supplierItemCostHistory.supplierItemId, setup.caseItem.id)))
      .length;
    // 300.00 → 304.00 is within the default 2% (6.00 per case).
    const draft = await createInvoice(
      database(),
      clerk,
      invoice(setup, {
        statedTotal: "3065.00",
        lines: [
          { kind: "ITEM", receiptLineId: setup.receiptLine.receiptLineId, quantity: "10", unitPrice: "304" },
          { kind: "FREIGHT", description: "Delivery", amount: "25.00" },
        ],
      }),
    );

    expect(await codeOf(approveInvoice(database(), clerk, draft.id, { expectedVersion: draft.version }))).toBe("PERMISSION_DENIED");

    const approved = await approveInvoice(database(), approver, draft.id, { expectedVersion: draft.version });

    expect(approved.status).toBe("APPROVED");

    const [stored] = await database().select().from(supplierInvoiceVariances).where(eq(supplierInvoiceVariances.invoiceId, draft.id));

    expect(stored).toMatchObject({
      priceVariance: "4.0000",
      pricePercent: "1.33",
      amountVariance: "40.00",
      priceWithinTolerance: true,
      withinTolerance: true,
    });

    // Record only: no ledger row, balance, average cost, cost history or last cost changed.
    const [balanceAfter] = await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, setup.vodka.id));
    const [item] = await database().select().from(supplierItems).where(eq(supplierItems.id, setup.caseItem.id));

    expect(balanceAfter).toEqual(balanceBefore);
    expect((await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, setup.vodka.id))).length).toBe(ledgerBefore);
    expect((await database().select().from(supplierItemCostHistory).where(eq(supplierItemCostHistory.supplierItemId, setup.caseItem.id))).length).toBe(
      historyBefore,
    );
    expect(item!.lastUnitCost).toBe("300.0000");

    const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.action, "inventory.invoice-approved"));

    expect(audit?.details).toMatchObject({ lineCount: 2, linesOutsideTolerance: 0 });
  });

  it("needs a reason for lines outside tolerance or short, and totals that match", async () => {
    const setup = await received({ received: "8" });
    const draft = await createInvoice(
      database(),
      clerk,
      invoice(setup, {
        statedTotal: "3125.00",
        lines: [{ kind: "ITEM", receiptLineId: setup.receiptLine.receiptLineId, quantity: "10", unitPrice: "310" }],
      }),
    );

    expect(draft.totalsMatch).toBe(false);
    expect(await codeOf(approveInvoice(database(), approver, draft.id, { expectedVersion: draft.version }))).toBe("INVOICE_TOTAL_MISMATCH");

    const fixed = await updateInvoice(database(), clerk, draft.id, {
      ...invoice(setup),
      statedTotal: "3075.00",
      lines: [
        { kind: "ITEM", receiptLineId: setup.receiptLine.receiptLineId, quantity: "10", unitPrice: "310" },
        { kind: "CREDIT", description: "Promo", amount: "25.00" },
      ],
      expectedVersion: draft.version,
    });

    expect(fixed.lines[1]).toMatchObject({ kind: "CREDIT", amount: "-25.00" });
    expect(fixed.linesNeedingReason).toBe(1);
    expect(fixed.lines[0]!.variance).toMatchObject({ quantityMatches: false, priceWithinTolerance: false });
    expect(await codeOf(approveInvoice(database(), approver, draft.id, { expectedVersion: fixed.version }))).toBe("INVOICE_VARIANCE_REASON_REQUIRED");

    const approved = await approveInvoice(database(), approver, draft.id, { reason: "Credit note promised for 2 cases", expectedVersion: fixed.version });

    expect(approved).toMatchObject({ status: "APPROVED", approvalReason: "Credit note promised for 2 cases" });
  });

  it("disputes, voids with a reason, releases the receipt line, and freezes finished invoices", async () => {
    const setup = await received();
    const draft = await createInvoice(database(), clerk, invoice(setup));
    const disputed = await disputeInvoice(database(), approver, draft.id, { reason: "Wrong case price", expectedVersion: draft.version });

    expect(disputed).toMatchObject({ status: "DISPUTED", disputeReason: "Wrong case price" });

    const voided = await voidInvoice(database(), approver, draft.id, { reason: "Supplier reissued", expectedVersion: disputed.version });

    expect(voided.status).toBe("VOIDED");
    expect(await listInvoiceableReceiptLines(database(), clerk, { supplierId: setup.supplier.id })).toHaveLength(1);

    // The same supplier number may be entered again once the first is voided.
    const again = await createInvoice(database(), clerk, invoice(setup));

    expect(again.status).toBe("DRAFT");
    expect(await codeOf(updateInvoice(database(), clerk, draft.id, { ...invoice(setup), expectedVersion: voided.version }))).toBe("INVOICE_NOT_EDITABLE");
    expect(await codeOf(database().update(supplierInvoices).set({ statedTotal: "1.00" }).where(eq(supplierInvoices.id, draft.id)))).toBe(
      "supplier_invoices_finished_frozen",
    );
    expect(await codeOf(database().delete(supplierInvoices).where(eq(supplierInvoices.id, draft.id)))).toBe("supplier_invoices_no_delete");
    expect(await codeOf(database().delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, draft.id)))).toBe("supplier_invoice_lines_frozen");
  });

  it("refuses another supplier's receipt, card numbers in notes, and records without cost view", async () => {
    const setup = await received();
    const other = await received();

    expect(
      await codeOf(
        createInvoice(database(), clerk, invoice(setup, { lines: [{ kind: "ITEM", receiptLineId: other.receiptLine.receiptLineId, quantity: "10", unitPrice: "300" }] })),
      ),
    ).toBe("RECEIPT_LINE_OTHER_SUPPLIER");
    expect(await codeOf(createInvoice(database(), clerk, invoice(setup, { notes: "Paid with 4111111111111111" })))).toBe("CARD_DATA_REFUSED");

    const noCost = await actorWith(database(), scenario, ["purchasing.view", "purchasing.invoices.record"]);

    expect(await codeOf(createInvoice(database(), noCost, invoice(setup)))).toBe("PERMISSION_DENIED");

    const draft = await createInvoice(database(), clerk, invoice(setup));
    const hidden = await getInvoice(database(), noCost, draft.id);

    expect(hidden).toMatchObject({ statedTotal: null, linesTotal: null });
    expect(hidden.lines[0]).toMatchObject({ amount: null, unitPrice: null, variance: null });
  });

  it("stores a scanned copy outside the database, removing it if recording fails", async () => {
    const setup = await received();
    const draft = await createInvoice(database(), clerk, invoice(setup));
    const { storage, files } = memoryStorage();

    expect(await codeOf(uploadInvoiceFile(database(), storage, clerk, draft.id, { bytes: PDF, mimeType: "application/pdf", fileName: "inv.pdf", expectedVersion: 99 }))).toBe(
      "CONCURRENCY_CONFLICT",
    );
    expect(files.size).toBe(0);

    const withFile = await uploadInvoiceFile(database(), storage, clerk, draft.id, {
      bytes: PDF,
      mimeType: "application/pdf",
      fileName: "inv.pdf",
      expectedVersion: draft.version,
    });

    expect(withFile.file).toEqual({ name: "inv.pdf", contentType: "application/pdf", sizeBytes: PDF.length });
    expect(files.size).toBe(1);

    // Replacing it removes the old bytes; a text file is refused.
    await uploadInvoiceFile(database(), storage, clerk, draft.id, { bytes: PDF, mimeType: "application/pdf", fileName: "v2.pdf", expectedVersion: withFile.version });
    expect(files.size).toBe(1);
    expect(
      await codeOf(uploadInvoiceFile(database(), storage, clerk, draft.id, { bytes: new TextEncoder().encode("hi"), mimeType: "text/plain", fileName: "x.txt", expectedVersion: withFile.version + 1 })),
    ).toBe("VALIDATION_FAILED");
  });

  it("shows variances and received-not-invoiced lines in the inventory report", async () => {
    const setup = await received();
    const pending = await received();
    const draft = await createInvoice(
      database(),
      clerk,
      invoice(setup, {
        invoiceDate: (await readLocationClock(database(), scenario.locationA, new Date())).businessDate,
        statedTotal: "3045.00",
        lines: [
          { kind: "ITEM", receiptLineId: setup.receiptLine.receiptLineId, quantity: "10", unitPrice: "302" },
          { kind: "FREIGHT", description: "Delivery", amount: "25.00" },
        ],
      }),
    );

    await approveInvoice(database(), approver, draft.id, { expectedVersion: draft.version });

    const today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
    const report = await runReport(database(), approver, "inventory", { locationId: scenario.locationA, from: today, to: today });
    const variances = report.sections.find((section) => section.key === "invoice-variances")!;
    const uninvoiced = report.sections.find((section) => section.key === "received-not-invoiced")!;

    expect(variances.rows.some((row) => row.priceVariance === "2.0000")).toBe(true);
    expect(uninvoiced.rows.some((row) => row.po === pending.receiptLine.poNumber)).toBe(true);
    expect(uninvoiced.rows.some((row) => row.po === setup.receiptLine.poNumber)).toBe(false);
  });
});
