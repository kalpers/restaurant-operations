import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, inventoryTransactions, purchaseOrderLines, purchaseOrders } from "@/db/schema";
import { getItemConfiguration, setItemLocation } from "@/modules/inventory/services/item-service";
import { submitPurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import {
  createSuggestedOrders,
  previewSuggestedOrders,
} from "@/modules/inventory/services/suggested-order-service";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  createInventoryScenario,
  post,
  stockedItem,
  supplierWith,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";
import { newKey } from "../../fixtures/order-fixtures";

// Phase 19 decisions D7/D8 and policies 15-18: drafts per preferred supplier, never submitted,
// sized to the shortfall minus what's already on order, idempotent on retry.

const database = () => getDatabase();

describe("suggested purchase orders (Phase 19)", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** Vodka in mL: 2,000 on hand, reorder at 6,000, target 24,000; a case is 12,000 mL. */
  async function lowVodka(options: { preferred?: boolean; cost?: string | null } = {}) {
    const vodka = await stockedItem(database(), scenario.admin, {
      measurementType: "VOLUME",
      baseUnitId: scenario.units.ml,
      name: "Vodka",
      conversions: [
        { fromUnitId: scenario.units.case, toUnitId: scenario.units.bottle, factor: "12" },
        { fromUnitId: scenario.units.bottle, toUnitId: scenario.units.l, factor: "1" },
      ],
      levels: { parLevel: "24000", reorderLevel: "6000", reorderTarget: "24000" },
    });
    const {
      supplier,
      supplierItems: [caseItem],
    } = await supplierWith(database(), scenario.admin, [
      { inventoryItemId: vodka.id, purchaseUnitId: scenario.units.case, lastUnitCost: options.cost ?? "300.0000" },
    ]);

    await post(database(), scenario.admin, {
      inventoryItemId: vodka.id,
      type: "RECEIVE",
      quantity: "2000",
      unitOfMeasureId: scenario.units.ml,
      incomingTotalCost: "50.00",
    });

    if (options.preferred !== false) {
      const config = await getItemConfiguration(database(), scenario.admin, vodka.id);
      const here = config.locations.find((row) => row.locationId === scenario.locationA)!;

      await setItemLocation(database(), scenario.admin, vodka.id, {
        parLevel: here.parLevel,
        reorderLevel: here.reorderLevel,
        reorderTarget: here.reorderTarget,
        storageNote: null,
        active: true,
        preferredSupplierItemId: caseItem!.id,
        expectedVersion: here.version,
      });
    }

    return { vodka, supplier, caseItem: caseItem! };
  }

  it("previews whole cases for the shortfall and writes nothing", async () => {
    const { vodka, supplier } = await lowVodka();
    const preview = await previewSuggestedOrders(database(), scenario.admin);
    const group = preview.suppliers.find((row) => row.supplierId === supplier.id)!;

    // Need 24,000 - 2,000 = 22,000 mL; 22,000 / 12,000 = 1.83 -> 2 cases at 300.
    expect(group.lines).toEqual([
      expect.objectContaining({
        inventoryItemId: vodka.id,
        needBaseQuantity: "22000.0000",
        orderedQuantity: "2",
        estimatedLineCost: "600.0000",
      }),
    ]);
    expect(await database().select().from(purchaseOrders).where(eq(purchaseOrders.supplierId, supplier.id))).toHaveLength(0);
  });

  it("creates one DRAFT per supplier, moves no stock, and replays a retry", async () => {
    const { vodka, supplier } = await lowVodka();
    const ledgerBefore = (
      await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, vodka.id))
    ).length;
    const key = newKey();
    const first = await createSuggestedOrders(database(), scenario.admin, { idempotencyKey: key });
    const retry = await createSuggestedOrders(database(), scenario.admin, { idempotencyKey: key });

    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ ...first, replayed: true });

    const orders = await database().select().from(purchaseOrders).where(eq(purchaseOrders.supplierId, supplier.id));

    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("DRAFT");

    const lines = await database().select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, orders[0]!.id));

    expect(lines.map((line) => line.orderedQuantity)).toEqual(["2.0000"]);
    expect(
      (await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, vodka.id))).length,
    ).toBe(ledgerBefore);

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "purchasing.suggested-orders-created"));

    expect(audit.some((row) => (row.details as { poNumbers: string[] }).poNumbers.includes(orders[0]!.poNumber))).toBe(true);
  });

  it("subtracts what's already on order, so a second run adds nothing", async () => {
    const { supplier } = await lowVodka();
    const first = await createSuggestedOrders(database(), scenario.admin, { idempotencyKey: newKey() });
    const draft = first.purchaseOrders.find((order) => order.supplierId === supplier.id)!;

    // A submitted order still counts as on order.
    await submitPurchaseOrder(database(), scenario.admin, draft.id, 2);

    const second = await createSuggestedOrders(database(), scenario.admin, { idempotencyKey: newKey() });

    expect(second.purchaseOrders.find((order) => order.supplierId === supplier.id)).toBeUndefined();
  });

  it("lists items with no preferred supplier and leaves them off", async () => {
    const { vodka } = await lowVodka({ preferred: false });
    const preview = await previewSuggestedOrders(database(), scenario.admin);

    expect(preview.withoutSupplier.map((row) => row.inventoryItemId)).toContain(vodka.id);
    expect(preview.suppliers.flatMap((row) => row.lines).map((line) => line.inventoryItemId)).not.toContain(vodka.id);
  });

  it("hides cost without inventory.cost.view and refuses without purchasing.manage", async () => {
    await lowVodka();

    const buyer = await actorWith(database(), scenario, ["purchasing.manage"]);
    const preview = await previewSuggestedOrders(database(), buyer);

    expect(preview.suppliers.flatMap((row) => row.lines).every((line) => line.estimatedLineCost === null)).toBe(true);
    await expect(previewSuggestedOrders(database(), scenario.viewer)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      createSuggestedOrders(database(), scenario.viewer, { idempotencyKey: newKey() }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("refuses a preferred supplier item that sells a different item", async () => {
    const { vodka } = await lowVodka({ preferred: false });
    const gin = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each, name: "Gin" });
    const {
      supplierItems: [ginItem],
    } = await supplierWith(database(), scenario.admin, [{ inventoryItemId: gin.id, purchaseUnitId: scenario.units.each }]);
    const config = await getItemConfiguration(database(), scenario.admin, vodka.id);
    const here = config.locations.find((row) => row.locationId === scenario.locationA)!;

    await expect(
      setItemLocation(database(), scenario.admin, vodka.id, {
        parLevel: here.parLevel,
        reorderLevel: here.reorderLevel,
        reorderTarget: here.reorderTarget,
        storageNote: null,
        active: true,
        preferredSupplierItemId: ginItem!.id,
        expectedVersion: here.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
