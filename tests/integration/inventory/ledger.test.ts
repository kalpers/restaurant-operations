import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, inventoryItemLocations, inventoryTransactions, locationSettings } from "@/db/schema";
import {
  ledgerQuantityOnHand,
  listOnHand,
  listTransactions,
  reconcileBalances,
} from "@/modules/inventory/queries/stock-queries";
import { setItemLocation, updateItem } from "@/modules/inventory/services/item-service";
import { recordAdjustment } from "@/modules/inventory/services/stock-operations";

import {
  allowNegativeInventory,
  createInventoryScenario,
  post,
  stockedItem,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";

const database = () => getDatabase();

describe("inventory ledger and balance", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const balanceOf = async (inventoryItemId: string, locationId = scenario.locationA) => {
    const [row] = await database()
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.inventoryItemId, inventoryItemId));

    return row && row.locationId === locationId ? row : undefined;
  };

  const ledgerOf = (inventoryItemId: string) =>
    ledgerQuantityOnHand(database(), {
      organizationId: scenario.organizationId,
      inventoryItemId,
      locationId: scenario.locationA,
    });

  it("posts each type with its sign and the exact resulting balance", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    const each = scenario.units.each;
    const results = [];

    for (const [type, quantity] of [
      ["RECEIVE", "10"],
      ["CONSUME", "1.5"],
      ["WASTE", "0.5"],
      ["ADJUST_INCREASE", "2"],
      ["ADJUST_DECREASE", "1"],
      ["COUNT_INCREASE", "0.25"],
      ["COUNT_DECREASE", "0.25"],
    ] as const) {
      results.push(
        await post(database(), scenario.admin, {
          inventoryItemId: item.id,
          type,
          quantity,
          unitOfMeasureId: each,
          incomingTotalCost: type === "RECEIVE" ? "20" : undefined,
          reasonCode: type.startsWith("ADJUST") || type === "WASTE" ? "OTHER" : null,
        }),
      );
    }

    expect(results.map((result) => result.baseQuantityDelta)).toEqual([
      "10.0000",
      "-1.5000",
      "-0.5000",
      "2.0000",
      "-1.0000",
      "0.2500",
      "-0.2500",
    ]);
    expect(results.at(-1)?.quantityAfter).toBe("9.0000");
    expect((await balanceOf(item.id))?.quantityOnHand).toBe("9.0000");
    expect(await ledgerOf(item.id)).toBe("9.0000");
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
  });

  it("converts entered units to the base unit through the item's packaging", async () => {
    const vodka = await stockedItem(database(), scenario.admin, {
      measurementType: "VOLUME",
      baseUnitId: scenario.units.ml,
      conversions: [
        { fromUnitId: scenario.units.case, toUnitId: scenario.units.bottle, factor: "12" },
        { fromUnitId: scenario.units.bottle, toUnitId: scenario.units.l, factor: "1" },
      ],
    });
    const received = await post(database(), scenario.admin, {
      inventoryItemId: vodka.id,
      type: "RECEIVE",
      quantity: "1",
      unitOfMeasureId: scenario.units.case,
      incomingTotalCost: "300",
    });

    expect(received).toMatchObject({ baseQuantityDelta: "12000.0000", quantityAfter: "12000.0000", unitCost: "0.0250" });

    const [row] = await database()
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.id, received.transactionId));

    // Both the entered quantity and unit and the base delta are kept.
    expect(row).toMatchObject({ quantity: "1.0000", unitOfMeasureId: scenario.units.case, baseQuantityDelta: "12000.0000" });
  });

  it("refuses a unit with no conversion path", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

    await expect(
      post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: "1",
        unitOfMeasureId: scenario.units.kg,
        incomingTotalCost: "1",
      }),
    ).rejects.toMatchObject({ code: "NO_CONVERSION" });
  });

  it("keeps the ledger append-only in the database", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    const posted = await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity: "1",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "1",
    });

    await expect(
      database()
        .update(inventoryTransactions)
        .set({ notes: "edited" })
        .where(eq(inventoryTransactions.id, posted.transactionId)),
    ).rejects.toThrow();
    await expect(
      database().delete(inventoryTransactions).where(eq(inventoryTransactions.id, posted.transactionId)),
    ).rejects.toThrow();
  });

  it("writes neither ledger nor balance when a posting is refused", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

    await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity: "2",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "2",
    });
    await expect(
      recordAdjustment(database(), scenario.admin, {
        inventoryItemId: item.id,
        quantity: "5",
        unitOfMeasureId: scenario.units.each,
        direction: "DECREASE",
        reasonCode: "OTHER",
        notes: null,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect((await balanceOf(item.id))?.quantityOnHand).toBe("2.0000");
    expect(await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, item.id))).toHaveLength(1);
  });

  it("serializes simultaneous postings with no lost update", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post(database(), scenario.admin, {
          inventoryItemId: item.id,
          type: "RECEIVE",
          quantity: "1.25",
          unitOfMeasureId: scenario.units.each,
          incomingTotalCost: String(index + 1),
        }),
      ),
    );

    expect((await balanceOf(item.id))?.quantityOnHand).toBe("25.0000");
    expect(await ledgerOf(item.id)).toBe("25.0000");

    const rows = await database()
      .select({ quantityAfter: inventoryTransactions.quantityAfter })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.inventoryItemId, item.id))
      .orderBy(inventoryTransactions.sequence);

    // Each posting saw the one before it: running balances step by exactly 1.25.
    expect(rows.map((row) => row.quantityAfter)).toEqual(
      Array.from({ length: 20 }, (_, index) => ((index + 1) * 1.25).toFixed(4)),
    );
  });

  it("refuses to post for an item not stocked here, inactive, or from another organization", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    const base = { inventoryItemId: item.id, type: "RECEIVE" as const, quantity: "1", unitOfMeasureId: scenario.units.each, incomingTotalCost: "1" };

    await expect(post(database(), scenario.adminAtB, base)).rejects.toMatchObject({ code: "ITEM_NOT_STOCKED_HERE" });
    await expect(post(database(), scenario.otherOrganization, base)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await database()
      .update(inventoryItemLocations)
      .set({ active: false })
      .where(eq(inventoryItemLocations.inventoryItemId, item.id));
    await expect(post(database(), scenario.admin, base)).rejects.toMatchObject({ code: "ITEM_NOT_STOCKED_HERE" });
  });

  it("records the business date from the location's cutoff", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    const [settings] = await database()
      .select({ cutoff: locationSettings.businessDayCutoff })
      .from(locationSettings)
      .where(eq(locationSettings.locationId, scenario.locationA));

    expect(settings?.cutoff).toBe("04:00:00");

    // Fixture locations are in America/Detroit: 2026-03-14 07:30 UTC is 03:30 local, before 4 AM.
    const posted = await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity: "1",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "1",
      occurredAt: new Date("2026-03-14T07:30:00Z"),
    });
    const [row] = await database()
      .select({ businessDate: inventoryTransactions.businessDate })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.id, posted.transactionId));

    expect(row?.businessDate).toBe("2026-03-13");
    expect(
      await ledgerQuantityOnHand(database(), {
        organizationId: scenario.organizationId,
        inventoryItemId: item.id,
        locationId: scenario.locationA,
        throughBusinessDate: "2026-03-12",
      }),
    ).toBe("0.0000");
  });

  describe("negative inventory policy", () => {
    const consume = (inventoryItemId: string, quantity: string) =>
      post(database(), scenario.admin, {
        inventoryItemId,
        type: "CONSUME",
        quantity,
        unitOfMeasureId: scenario.units.each,
        reference: { type: "FIXTURE", id: crypto.randomUUID() },
      });

    it("defaults to false and refuses consumption below zero", async () => {
      const [settings] = await database()
        .select({ allow: locationSettings.allowNegativeInventory })
        .from(locationSettings)
        .where(eq(locationSettings.locationId, scenario.locationA));

      expect(settings?.allow).toBe(false);

      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await expect(consume(item.id, "1")).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    });

    it("when allowed, lets only CONSUME go below zero, and never clamps", async () => {
      await allowNegativeInventory(database(), scenario.locationA, true);

      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      expect((await consume(item.id, "3")).quantityAfter).toBe("-3.0000");
      expect(await ledgerOf(item.id)).toBe("-3.0000");

      for (const type of ["WASTE", "ADJUST_DECREASE", "COUNT_DECREASE"] as const) {
        await expect(
          post(database(), scenario.admin, {
            inventoryItemId: item.id,
            type,
            quantity: "1",
            unitOfMeasureId: scenario.units.each,
            reasonCode: "OTHER",
          }),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
      }

      // Increases still work from a negative balance.
      expect(
        (
          await post(database(), scenario.admin, {
            inventoryItemId: item.id,
            type: "ADJUST_INCREASE",
            quantity: "1",
            unitOfMeasureId: scenario.units.each,
            reasonCode: "FOUND_STOCK",
          })
        ).quantityAfter,
      ).toBe("-2.0000");

      await allowNegativeInventory(database(), scenario.locationA, false);
    });
  });

  describe("weighted-average cost", () => {
    const receive = (inventoryItemId: string, quantity: string, totalCost: string) =>
      post(database(), scenario.admin, {
        inventoryItemId,
        type: "RECEIVE",
        quantity,
        unitOfMeasureId: scenario.units.each,
        incomingTotalCost: totalCost,
      });

    it("10 @ 2.0000 then 10 @ 3.0000 gives 2.5000, persisted", async () => {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      expect((await receive(item.id, "10", "20")).averageCostAfter).toBe("2.0000");
      expect((await receive(item.id, "10", "30")).averageCostAfter).toBe("2.5000");
      expect((await balanceOf(item.id))?.weightedAverageCost).toBe("2.5000");
    });

    it("uses the persisted four-place average as the next basis", async () => {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await receive(item.id, "1", "1");
      // (1 * 1 + 2 * 1.00005) / 3 = 1.0000333 -> 1.0000
      expect((await receive(item.id, "2", "2.0001")).averageCostAfter).toBe("1.0000");
      // Uses 1.0000, not 1.0000333: (3 * 1 + 1 * 1.0002) / 4 = 1.00005 -> 1.0001
      expect((await receive(item.id, "1", "1.0002")).averageCostAfter).toBe("1.0001");
    });

    it("keeps the average while a receipt leaves stock negative, then resets on crossing zero", async () => {
      await allowNegativeInventory(database(), scenario.locationA, true);

      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await receive(item.id, "2", "4");
      await post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "CONSUME",
        quantity: "10",
        unitOfMeasureId: scenario.units.each,
        reference: { type: "FIXTURE", id: crypto.randomUUID() },
      });

      expect((await receive(item.id, "5", "50")).averageCostAfter).toBe("2.0000");
      expect((await receive(item.id, "4", "24")).averageCostAfter).toBe("6.0000");
      expect((await balanceOf(item.id))?.quantityOnHand).toBe("1.0000");

      await allowNegativeInventory(database(), scenario.locationA, false);
    });

    it("values outgoing movements at the current average without changing it", async () => {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await receive(item.id, "4", "10");

      const waste = await post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "WASTE",
        quantity: "1",
        unitOfMeasureId: scenario.units.each,
        reasonCode: "SPOILAGE",
      });

      expect(waste).toMatchObject({ unitCost: "2.5000", totalCost: "2.5000", averageCostAfter: "2.5000" });
    });
  });

  describe("cost visibility and configuration", () => {
    it("hides cost from a viewer without inventory.cost.view", async () => {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: "4",
        unitOfMeasureId: scenario.units.each,
        incomingTotalCost: "10",
      });

      const [adminRow] = (await listOnHand(database(), scenario.admin)).filter((row) => row.inventoryItemId === item.id);
      const [viewerRow] = (await listOnHand(database(), scenario.viewer)).filter((row) => row.inventoryItemId === item.id);
      const [viewerTx] = await listTransactions(database(), scenario.viewer, { inventoryItemId: item.id });

      expect(adminRow).toMatchObject({ quantityOnHand: "4.0000", weightedAverageCost: "2.5000", stockValue: "10.0000" });
      expect(viewerRow).toMatchObject({ quantityOnHand: "4.0000", weightedAverageCost: null, stockValue: null });
      expect(viewerTx).toMatchObject({ unitCost: null, totalCost: null, averageCostAfter: null });
    });

    it("locks the stock unit once an item has history, and rejects stale level edits", async () => {
      const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

      await post(database(), scenario.admin, {
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: "1",
        unitOfMeasureId: scenario.units.each,
        incomingTotalCost: "1",
      });

      await expect(
        updateItem(database(), scenario.admin, item.id, {
          name: item.name,
          description: null,
          measurementType: "COUNT",
          baseUnitId: scenario.units.slice,
          active: true,
          expectedVersion: item.version,
        }),
      ).rejects.toMatchObject({ code: "BASE_UNIT_LOCKED" });

      const [configuration] = await database()
        .select()
        .from(inventoryItemLocations)
        .where(eq(inventoryItemLocations.inventoryItemId, item.id));
      const edit = (reorderLevel: string) =>
        setItemLocation(database(), scenario.admin, item.id, {
          parLevel: "10",
          reorderLevel,
          reorderTarget: "10",
          storageNote: null,
          active: true,
          expectedVersion: configuration!.version,
        });

      await edit("2");
      await expect(edit("3")).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
      await expect(
        setItemLocation(database(), scenario.admin, item.id, {
          parLevel: "5",
          reorderLevel: "8",
          reorderTarget: "10",
          storageNote: null,
          active: true,
          expectedVersion: configuration!.version + 1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_THRESHOLD" });
    });

    it("refuses a base unit of the wrong measurement type, in service and database", async () => {
      await expect(
        stockedItem(database(), scenario.admin, { measurementType: "VOLUME", baseUnitId: scenario.units.each }),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_BASE_UNIT" });
    });
  });
});
