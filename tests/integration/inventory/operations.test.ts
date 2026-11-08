import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, inventoryTransactions } from "@/db/schema";
import { listLowStock, listTransactions, reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import { recordAdjustment, recordWaste, transferStock } from "@/modules/inventory/services/stock-operations";
import { AuthorizationError } from "@/shared/errors/app-error";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  allowNegativeInventory,
  createInventoryScenario,
  post,
  stockedItem,
  supplierWith,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";

const database = () => getDatabase();

describe("waste, adjustments, transfers and low stock", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const balanceAt = async (inventoryItemId: string, locationId: string) => {
    const [row] = await database()
      .select()
      .from(inventoryBalances)
      .where(and(eq(inventoryBalances.inventoryItemId, inventoryItemId), eq(inventoryBalances.locationId, locationId)));

    return row;
  };

  async function beefWith(ounces: string, totalCost = "0") {
    const beef = await stockedItem(database(), scenario.admin, {
      measurementType: "WEIGHT",
      baseUnitId: scenario.units.ozWeight,
      alsoAt: [scenario.adminAtB],
    });

    if (ounces !== "0") {
      await post(database(), scenario.admin, {
        inventoryItemId: beef.id,
        type: "RECEIVE",
        quantity: ounces,
        unitOfMeasureId: scenario.units.ozWeight,
        incomingTotalCost: totalCost,
      });
    }

    return beef;
  }

  describe("waste", () => {
    it("decreases stock with a reason and keeps an append-only WASTE row", async () => {
      const beef = await beefWith("64", "32");
      const result = await recordWaste(database(), scenario.admin, {
        inventoryItemId: beef.id,
        quantity: "1",
        unitOfMeasureId: scenario.units.lb,
        reasonCode: "SPOILAGE",
        notes: "Left out overnight",
      });

      expect(result).toMatchObject({ baseQuantityDelta: "-16.0000", quantityAfter: "48.0000", totalCost: "8.0000" });

      const [row] = await listTransactions(database(), scenario.admin, { transactionType: "WASTE", inventoryItemId: beef.id });

      expect(row).toMatchObject({ reasonCode: "SPOILAGE", quantity: "-1.0000", unitCode: "LB", notes: "Left out overnight" });
    });

    it("requires a reason in the database too", async () => {
      const beef = await beefWith("10");

      await expect(
        post(database(), scenario.admin, {
          inventoryItemId: beef.id,
          type: "WASTE",
          quantity: "1",
          unitOfMeasureId: scenario.units.ozWeight,
          reasonCode: null,
        }),
      ).rejects.toThrow();
    });

    it("never goes below zero, even when consumption may", async () => {
      await allowNegativeInventory(database(), scenario.locationA, true);

      const beef = await beefWith("2");

      await expect(
        recordWaste(database(), scenario.admin, {
          inventoryItemId: beef.id,
          quantity: "3",
          unitOfMeasureId: scenario.units.ozWeight,
          reasonCode: "OTHER",
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

      await allowNegativeInventory(database(), scenario.locationA, false);
    });

    it("requires inventory.waste", async () => {
      const beef = await beefWith("2");

      await expect(
        recordWaste(database(), scenario.viewer, {
          inventoryItemId: beef.id,
          quantity: "1",
          unitOfMeasureId: scenario.units.ozWeight,
          reasonCode: "OTHER",
          notes: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("manual adjustments", () => {
    it("increases and decreases with exact unit conversion", async () => {
      const beef = await beefWith("0");
      const up = await recordAdjustment(database(), scenario.admin, {
        inventoryItemId: beef.id,
        quantity: "2.5",
        unitOfMeasureId: scenario.units.lb,
        direction: "INCREASE",
        reasonCode: "FOUND_STOCK",
        notes: null,
      });
      const down = await recordAdjustment(database(), scenario.admin, {
        inventoryItemId: beef.id,
        quantity: "4",
        unitOfMeasureId: scenario.units.ozWeight,
        direction: "DECREASE",
        reasonCode: "DATA_CORRECTION",
        notes: "Miskeyed",
      });

      expect([up.baseQuantityDelta, down.baseQuantityDelta, down.quantityAfter]).toEqual(["40.0000", "-4.0000", "36.0000"]);
    });

    it("requires inventory.adjust, and waste permission alone isn't enough", async () => {
      const beef = await beefWith("2");
      const cook = await actorWith(database(), scenario, ["inventory.view", "inventory.waste"]);

      await expect(
        recordAdjustment(database(), cook, {
          inventoryItemId: beef.id,
          quantity: "1",
          unitOfMeasureId: scenario.units.ozWeight,
          direction: "INCREASE",
          reasonCode: "OTHER",
          notes: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("transfers", () => {
    it("posts a paired out and in with one reference, carries cost, and keeps the total", async () => {
      const beef = await beefWith("100", "250");
      const { transferId, out, in: arrived } = await transferStock(database(), scenario.admin, {
        inventoryItemId: beef.id,
        quantity: "40",
        unitOfMeasureId: scenario.units.ozWeight,
        toLocationId: scenario.locationB,
        notes: null,
      });

      expect([out.baseQuantityDelta, arrived.baseQuantityDelta]).toEqual(["-40.0000", "40.0000"]);
      expect(arrived.averageCostAfter).toBe("2.5000");
      expect((await balanceAt(beef.id, scenario.locationA))?.quantityOnHand).toBe("60.0000");
      expect((await balanceAt(beef.id, scenario.locationB))?.quantityOnHand).toBe("40.0000");

      const pair = await database()
        .select({ type: inventoryTransactions.transactionType, location: inventoryTransactions.locationId })
        .from(inventoryTransactions)
        .where(eq(inventoryTransactions.referenceId, transferId));

      expect(pair.map((row) => row.type).sort()).toEqual(["TRANSFER_IN", "TRANSFER_OUT"]);
      expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
    });

    it("refuses to transfer more than is on hand, leaving both sides untouched", async () => {
      const beef = await beefWith("10");

      await expect(
        transferStock(database(), scenario.admin, {
          inventoryItemId: beef.id,
          quantity: "11",
          unitOfMeasureId: scenario.units.ozWeight,
          toLocationId: scenario.locationB,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
      expect((await balanceAt(beef.id, scenario.locationA))?.quantityOnHand).toBe("10.0000");
      expect((await balanceAt(beef.id, scenario.locationB))?.quantityOnHand ?? "0.0000").toBe("0.0000");
    });

    it("needs inventory.transfer at both locations", async () => {
      const beef = await beefWith("10");
      const onlyHere = await actorWith(database(), scenario, ["inventory.view", "inventory.transfer"]);

      await expect(
        transferStock(database(), onlyHere, {
          inventoryItemId: beef.id,
          quantity: "1",
          unitOfMeasureId: scenario.units.ozWeight,
          toLocationId: scenario.locationB,
          notes: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("refuses a destination that doesn't stock the item, or another organization's location", async () => {
      const notAtB = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await post(database(), scenario.admin, {
        inventoryItemId: notAtB.id,
        type: "RECEIVE",
        quantity: "5",
        unitOfMeasureId: scenario.units.each,
        incomingTotalCost: "5",
      });
      await expect(
        transferStock(database(), scenario.admin, {
          inventoryItemId: notAtB.id,
          quantity: "1",
          unitOfMeasureId: scenario.units.each,
          toLocationId: scenario.locationB,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "ITEM_NOT_STOCKED_HERE" });
      await expect(
        transferStock(database(), scenario.admin, {
          inventoryItemId: notAtB.id,
          quantity: "1",
          unitOfMeasureId: scenario.units.each,
          toLocationId: scenario.locationA,
          notes: null,
        }),
      ).rejects.toMatchObject({ code: "SAME_LOCATION" });
    });
  });

  describe("low stock", () => {
    async function levelled(onHand: string, levels = { parLevel: "20", reorderLevel: "5", reorderTarget: "15" }) {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each, levels });

      if (onHand !== "0") {
        await post(database(), scenario.admin, {
          inventoryItemId: item.id,
          type: "RECEIVE",
          quantity: onHand,
          unitOfMeasureId: scenario.units.each,
          incomingTotalCost: "1",
        });
      }

      return item;
    }

    const lowIds = async () => (await listLowStock(database(), scenario.admin)).map((row) => row.inventoryItemId);

    it("uses the at-or-below rule with exact suggestions", async () => {
      const above = await levelled("6");
      const equal = await levelled("5");
      const below = await levelled("2.5");
      const ids = await lowIds();

      expect(ids).not.toContain(above.id);
      expect(ids).toContain(equal.id);

      const [row] = (await listLowStock(database(), scenario.admin)).filter((entry) => entry.inventoryItemId === below.id);

      expect(row).toMatchObject({ suggestedQuantity: "12.5000", shortageToPar: "17.5000" });
    });

    it("reports a negative balance as it is", async () => {
      await allowNegativeInventory(database(), scenario.locationA, true);

      const item = await levelled("0");

      await post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "CONSUME",
        quantity: "3",
        unitOfMeasureId: scenario.units.each,
        reference: { type: "FIXTURE", id: crypto.randomUUID() },
      });

      const [row] = (await listLowStock(database(), scenario.admin)).filter((entry) => entry.inventoryItemId === item.id);

      expect(row).toMatchObject({ quantityOnHand: "-3.0000", suggestedQuantity: "18.0000" });
      await allowNegativeInventory(database(), scenario.locationA, false);
    });

    it("is location-specific and lists every active supplier option", async () => {
      const item = await levelled("0");

      await supplierWith(database(), scenario.admin, [{ inventoryItemId: item.id, purchaseUnitId: scenario.units.each, lastUnitCost: "1" }]);
      await supplierWith(database(), scenario.admin, [{ inventoryItemId: item.id, purchaseUnitId: scenario.units.each, lastUnitCost: "2" }]);

      const [row] = (await listLowStock(database(), scenario.admin)).filter((entry) => entry.inventoryItemId === item.id);

      expect(row?.supplierOptions).toHaveLength(2);
      expect((await listLowStock(database(), scenario.adminAtB)).map((entry) => entry.inventoryItemId)).not.toContain(item.id);
    });
  });
});
