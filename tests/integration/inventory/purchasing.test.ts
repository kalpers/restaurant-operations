import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryBalances,
  inventoryTransactions,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  supplierItemCostHistory,
  supplierItems,
} from "@/db/schema";
import { listLowStock } from "@/modules/inventory/queries/stock-queries";
import {
  addPurchaseOrderLine,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  removePurchaseOrderLine,
  submitPurchaseOrder,
  updatePurchaseOrderLine,
} from "@/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "@/modules/inventory/services/receiving-service";
import {
  createSupplierItem,
  listSupplierItemCostHistory,
  listSupplierItems,
  updateSupplier,
  updateSupplierItem,
} from "@/modules/inventory/services/supplier-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  createInventoryScenario,
  stockedItem,
  supplierWith,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";

const database = () => getDatabase();

describe("purchasing and receiving", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** Vodka in mL, bought by the case of 12 one-liter bottles. */
  async function vodkaSetup(lastUnitCost: string | null = "300.0000") {
    const vodka = await stockedItem(database(), scenario.admin, {
      measurementType: "VOLUME",
      baseUnitId: scenario.units.ml,
      conversions: [
        { fromUnitId: scenario.units.case, toUnitId: scenario.units.bottle, factor: "12" },
        { fromUnitId: scenario.units.bottle, toUnitId: scenario.units.l, factor: "1" },
      ],
      levels: { parLevel: "24000", reorderLevel: "6000", reorderTarget: "24000" },
    });
    const { supplier, supplierItems: [caseItem] } = await supplierWith(database(), scenario.admin, [
      { inventoryItemId: vodka.id, purchaseUnitId: scenario.units.case, lastUnitCost },
    ]);

    return { vodka, supplier, caseItem: caseItem! };
  }

  async function submittedOrder(cases = "10") {
    const setup = await vodkaSetup();
    const order = await createPurchaseOrder(database(), scenario.admin, {
      supplierId: setup.supplier.id,
      expectedAt: null,
      notes: null,
    });
    const line = await addPurchaseOrderLine(database(), scenario.admin, order.id, {
      supplierItemId: setup.caseItem.id,
      orderedQuantity: cases,
      unitPrice: null,
      expectedVersion: order.version,
    });
    const submitted = await submitPurchaseOrder(database(), scenario.admin, order.id, order.version + 1);

    return { ...setup, order: submitted, line };
  }

  const stockOf = async (inventoryItemId: string) => {
    const [row] = await database()
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.inventoryItemId, inventoryItemId));

    return row;
  };

  describe("suppliers and supplier items", () => {
    it("computes base units per purchase from the item's conversions", async () => {
      const { caseItem } = await vodkaSetup();

      expect(caseItem.baseUnitsPerPurchase).toBe("12000.0000");
    });

    it("refuses a purchase unit that can't be converted", async () => {
      const { vodka, supplier } = await vodkaSetup();

      await expect(
        createSupplierItem(database(), scenario.admin, supplier.id, {
          inventoryItemId: vodka.id,
          purchaseUnitId: scenario.units.kg,
          supplierSku: null,
          lastUnitCost: null,
        }),
      ).rejects.toMatchObject({ code: "NO_CONVERSION" });
    });

    it("lets one item come from several suppliers, with no preferred supplier", async () => {
      const { vodka } = await vodkaSetup();

      await supplierWith(database(), scenario.admin, [{ inventoryItemId: vodka.id, purchaseUnitId: scenario.units.bottle }]);

      expect(await listSupplierItems(database(), scenario.admin, { inventoryItemId: vodka.id })).toHaveLength(2);

      const columns = await database().execute(
        `SELECT column_name FROM information_schema.columns WHERE table_name IN ('supplier_items', 'suppliers', 'inventory_items', 'inventory_item_locations')` as never,
      );

      expect(
        (columns as unknown as { column_name: string }[]).filter((row) => /prefer/.test(row.column_name)),
      ).toEqual([]);
    });

    it("appends each listed cost to history and hides costs without cost access", async () => {
      const { caseItem } = await vodkaSetup("300.0000");

      await updateSupplierItem(database(), scenario.admin, caseItem.id, {
        supplierSku: "TITO-12",
        lastUnitCost: "310.0000",
        active: true,
        expectedVersion: caseItem.version,
      });

      const history = await listSupplierItemCostHistory(database(), scenario.admin, caseItem.id);

      expect(history.map((row) => [row.unitCost, row.source])).toEqual([
        ["310.0000", "MANUAL"],
        ["300.0000", "MANUAL"],
      ]);
      await expect(
        database().update(supplierItemCostHistory).set({ unitCost: "1" }).where(eq(supplierItemCostHistory.supplierItemId, caseItem.id)),
      ).rejects.toThrow();

      const purchaser = await actorWith(database(), scenario, ["purchasing.view"]);
      const [listed] = await listSupplierItems(database(), purchaser, { supplierId: caseItem.supplierId });

      expect(listed?.lastUnitCost).toBeNull();
      await expect(listSupplierItemCostHistory(database(), purchaser, caseItem.id)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });
  });

  describe("purchase order lifecycle", () => {
    it("numbers orders per location and edits only drafts", async () => {
      const { supplier, caseItem } = await vodkaSetup();
      const first = await createPurchaseOrder(database(), scenario.admin, { supplierId: supplier.id, expectedAt: null, notes: null });
      const second = await createPurchaseOrder(database(), scenario.admin, { supplierId: supplier.id, expectedAt: null, notes: null });

      expect(Number(second.poNumber.slice(3))).toBe(Number(first.poNumber.slice(3)) + 1);
      expect(first.poNumber).toMatch(/^PO-\d{6}$/);

      const line = await addPurchaseOrderLine(database(), scenario.admin, first.id, {
        supplierItemId: caseItem.id,
        orderedQuantity: "2.5",
        unitPrice: "299.9999",
        expectedVersion: first.version,
      });

      expect(line).toMatchObject({ orderedQuantity: "2.5000", unitPrice: "299.9999", lineTotal: "749.9998", baseUnitsPerPurchase: "12000.0000" });

      const edited = await updatePurchaseOrderLine(database(), scenario.admin, first.id, line.id, {
        orderedQuantity: "3",
        unitPrice: "299.9999",
        expectedVersion: first.version + 1,
      });

      expect(edited.lineTotal).toBe("899.9997");

      await expect(
        updatePurchaseOrderLine(database(), scenario.admin, first.id, line.id, {
          orderedQuantity: "4",
          unitPrice: "1",
          expectedVersion: first.version + 1,
        }),
      ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

      await submitPurchaseOrder(database(), scenario.admin, first.id, first.version + 2);
      await expect(
        removePurchaseOrderLine(database(), scenario.admin, first.id, line.id, first.version + 3),
      ).rejects.toMatchObject({ code: "PO_NOT_DRAFT" });

      const detail = await getPurchaseOrder(database(), scenario.admin, first.id);

      expect(detail).toMatchObject({ total: "899.9997", order: { status: "SUBMITTED" } });
    });

    it("refuses an empty order, an inactive supplier, and another supplier's item", async () => {
      const { supplier, caseItem } = await vodkaSetup();
      const order = await createPurchaseOrder(database(), scenario.admin, { supplierId: supplier.id, expectedAt: null, notes: null });

      await expect(submitPurchaseOrder(database(), scenario.admin, order.id, order.version)).rejects.toMatchObject({ code: "PO_EMPTY" });

      const other = await vodkaSetup();
      await expect(
        addPurchaseOrderLine(database(), scenario.admin, order.id, {
          supplierItemId: other.caseItem.id,
          orderedQuantity: "1",
          unitPrice: null,
          expectedVersion: order.version,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await addPurchaseOrderLine(database(), scenario.admin, order.id, {
        supplierItemId: caseItem.id,
        orderedQuantity: "1",
        unitPrice: null,
        expectedVersion: order.version,
      });
      await updateSupplier(database(), scenario.admin, supplier.id, {
        name: supplier.name,
        contactName: null,
        phone: null,
        email: null,
        active: false,
        expectedVersion: supplier.version,
      });
      await expect(submitPurchaseOrder(database(), scenario.admin, order.id, order.version + 1)).rejects.toMatchObject({
        code: "SUPPLIER_INACTIVE",
      });
    });

    it("needs a price when the supplier item lists none", async () => {
      const { supplier, caseItem } = await vodkaSetup(null);
      const order = await createPurchaseOrder(database(), scenario.admin, { supplierId: supplier.id, expectedAt: null, notes: null });

      await expect(
        addPurchaseOrderLine(database(), scenario.admin, order.id, {
          supplierItemId: caseItem.id,
          orderedQuantity: "1",
          unitPrice: null,
          expectedVersion: order.version,
        }),
      ).rejects.toMatchObject({ code: "PRICE_REQUIRED" });
    });

    it("submitting changes no stock", async () => {
      const { vodka } = await submittedOrder();

      expect(await stockOf(vodka.id)).toBeUndefined();
      expect(await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, vodka.id))).toEqual([]);
    });

    it("never resolves an old line's price from today's supplier item", async () => {
      const { caseItem, order, line } = await submittedOrder();
      const [current] = await database().select().from(supplierItems).where(eq(supplierItems.id, caseItem.id));

      await updateSupplierItem(database(), scenario.admin, caseItem.id, {
        supplierSku: null,
        lastUnitCost: "999.0000",
        active: true,
        expectedVersion: current!.version,
      });

      const detail = await getPurchaseOrder(database(), scenario.admin, order.id);

      expect(detail.lines[0]).toMatchObject({ id: line.id, unitPrice: "300.0000", lineTotal: "3000.0000" });
    });
  });

  describe("receiving", () => {
    it("receives partially, then fully, posting RECEIVE rows and updating cost", async () => {
      const { vodka, order, line } = await submittedOrder("10");

      const first = await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "6", actualUnitCost: null }],
        supplierReference: "INV-1",
        notes: null,
      });

      expect(first.status).toBe("PARTIALLY_RECEIVED");
      expect((await stockOf(vodka.id))?.quantityOnHand).toBe("72000.0000");
      expect((await stockOf(vodka.id))?.weightedAverageCost).toBe("0.0250");

      // The second delivery costs more; the actual cost drives the average.
      const second = await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "4", actualUnitCost: "330.0000" }],
        supplierReference: "INV-2",
        notes: null,
      });

      expect(second.status).toBe("RECEIVED");
      expect((await stockOf(vodka.id))?.quantityOnHand).toBe("120000.0000");
      // (72000 * 0.025 + 1320) / 120000 = 0.026
      expect((await stockOf(vodka.id))?.weightedAverageCost).toBe("0.0260");

      const ledger = await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, vodka.id));

      expect(ledger.map((row) => [row.transactionType, row.baseQuantityDelta, row.totalCost])).toEqual([
        ["RECEIVE", "72000.0000", "1800.0000"],
        ["RECEIVE", "48000.0000", "1320.0000"],
      ]);

      // The ordered price is kept; the actual one sits on the receipt line.
      const [orderLine] = await database().select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.id));
      const receiptLines = await database().select().from(purchaseOrderReceiptLines).where(eq(purchaseOrderReceiptLines.purchaseOrderLineId, line.id));

      expect(orderLine?.unitPrice).toBe("300.0000");
      expect(receiptLines.map((row) => [row.actualUnitCost, row.baseUnitCost])).toEqual([
        ["300.0000", "0.0250"],
        ["330.0000", "0.0275"],
      ]);

      const detail = await getPurchaseOrder(database(), scenario.admin, order.id);

      expect(detail.lines[0]).toMatchObject({ receivedQuantity: "10.0000", remainingQuantity: "0.0000" });
      await expect(
        receivePurchaseOrder(database(), scenario.admin, order.id, {
          lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "1", actualUnitCost: null }],
          supplierReference: null,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "PO_NOT_RECEIVABLE" });
    });

    it("refuses over-receiving, with no override", async () => {
      const { order, line } = await submittedOrder("10");

      await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "7", actualUnitCost: null }],
        supplierReference: null,
        notes: null,
      });
      await expect(
        receivePurchaseOrder(database(), scenario.admin, order.id, {
          lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "3.0001", actualUnitCost: null }],
          supplierReference: null,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "OVER_RECEIPT" });
    });

    it("is atomic: a bad line rolls back the whole receipt", async () => {
      const setup = await vodkaSetup();
      const bun = await stockedItem(database(), scenario.admin, {
        baseUnitId: scenario.units.each,
        conversions: [{ fromUnitId: scenario.units.pack, toUnitId: scenario.units.each, factor: "12" }],
      });
      const bunItem = await createSupplierItem(database(), scenario.admin, setup.supplier.id, {
        inventoryItemId: bun.id,
        purchaseUnitId: scenario.units.pack,
        supplierSku: null,
        lastUnitCost: "6.0000",
      });
      const order = await createPurchaseOrder(database(), scenario.admin, { supplierId: setup.supplier.id, expectedAt: null, notes: null });
      const vodkaLine = await addPurchaseOrderLine(database(), scenario.admin, order.id, {
        supplierItemId: setup.caseItem.id,
        orderedQuantity: "1",
        unitPrice: null,
        expectedVersion: order.version,
      });
      const bunLine = await addPurchaseOrderLine(database(), scenario.admin, order.id, {
        supplierItemId: bunItem.id,
        orderedQuantity: "2",
        unitPrice: null,
        expectedVersion: order.version + 1,
      });

      await submitPurchaseOrder(database(), scenario.admin, order.id, order.version + 2);
      await expect(
        receivePurchaseOrder(database(), scenario.admin, order.id, {
          lines: [
            { purchaseOrderLineId: vodkaLine.id, receivedQuantity: "1", actualUnitCost: null },
            { purchaseOrderLineId: bunLine.id, receivedQuantity: "3", actualUnitCost: null },
          ],
          supplierReference: null,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "OVER_RECEIPT" });

      expect(await stockOf(setup.vodka.id)).toBeUndefined();
      expect((await getPurchaseOrder(database(), scenario.admin, order.id)).receipts).toEqual([]);
    });

    it("can't receive a draft or a cancelled order; cancelling keeps what arrived", async () => {
      const { vodka, order, line } = await submittedOrder("10");

      await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "2", actualUnitCost: null }],
        supplierReference: null,
        notes: null,
      });

      const current = await getPurchaseOrder(database(), scenario.admin, order.id);

      await cancelPurchaseOrder(database(), scenario.admin, order.id, {
        reason: "Supplier out of stock",
        expectedVersion: current.order.version,
      });
      await expect(
        receivePurchaseOrder(database(), scenario.admin, order.id, {
          lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "1", actualUnitCost: null }],
          supplierReference: null,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "PO_NOT_RECEIVABLE" });
      expect((await stockOf(vodka.id))?.quantityOnHand).toBe("24000.0000");
    });

    it("records each receipt price in the supplier cost history", async () => {
      const { caseItem, order, line } = await submittedOrder("2");

      await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "2", actualUnitCost: "305.5000" }],
        supplierReference: null,
        notes: null,
      });

      const history = await listSupplierItemCostHistory(database(), scenario.admin, caseItem.id);

      expect(history[0]).toMatchObject({ unitCost: "305.5000", source: "RECEIPT" });
    });

    it("requires inventory.receive", async () => {
      const { order, line } = await submittedOrder();
      const purchaser = await actorWith(database(), scenario, ["purchasing.view", "purchasing.manage", "purchasing.submit"]);

      await expect(
        receivePurchaseOrder(database(), purchaser, order.id, {
          lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "1", actualUnitCost: null }],
          supplierReference: null,
          notes: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("keeps receipts append-only", async () => {
      const { order, line } = await submittedOrder("1");

      await receivePurchaseOrder(database(), scenario.admin, order.id, {
        lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "1", actualUnitCost: null }],
        supplierReference: null,
        notes: null,
      });

      await expect(
        database().update(purchaseOrderReceiptLines).set({ actualUnitCost: "1" }).where(eq(purchaseOrderReceiptLines.purchaseOrderLineId, line.id)),
      ).rejects.toThrow();
    });
  });

  describe("authorization and replenishment", () => {
    it("separates managing drafts from submitting", async () => {
      const { supplier, caseItem } = await vodkaSetup();
      const drafter = await actorWith(database(), scenario, ["purchasing.view", "purchasing.manage"]);
      const order = await createPurchaseOrder(database(), drafter, { supplierId: supplier.id, expectedAt: null, notes: null });

      await addPurchaseOrderLine(database(), drafter, order.id, {
        supplierItemId: caseItem.id,
        orderedQuantity: "1",
        unitPrice: null,
        expectedVersion: order.version,
      });
      await expect(submitPurchaseOrder(database(), drafter, order.id, order.version + 1)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(createPurchaseOrder(database(), scenario.viewer, { supplierId: supplier.id, expectedAt: null, notes: null })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("lists low stock with every supplier option and creates no order", async () => {
      const { vodka } = await vodkaSetup();
      const [row] = (await listLowStock(database(), scenario.admin)).filter((entry) => entry.inventoryItemId === vodka.id);

      expect(row).toMatchObject({ low: true, quantityOnHand: "0.0000", suggestedQuantity: "24000.0000" });
      expect(row?.supplierOptions).toHaveLength(1);
      expect((await getPurchaseOrder(database(), scenario.admin, crypto.randomUUID()).catch((error) => error)).code).toBe("NOT_FOUND");
    });
  });
});
