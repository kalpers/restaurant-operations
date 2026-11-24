import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  inventoryBalances,
  inventoryCostingChanges,
  inventoryItems,
  inventoryLotMovements,
  inventoryLots,
  inventoryTransactions,
  inventoryTransferLines,
} from "@/db/schema";
import { reconcileBalances, reconcileLots, reconcileLotValues } from "@/modules/inventory/queries/stock-queries";
import { changeCostingMethod } from "@/modules/inventory/services/costing-method-service";
import { disableLotTracking, enableLotTracking } from "@/modules/inventory/services/lot-service";
import { postSaleReversal } from "@/modules/inventory/services/order-consumption";
import { recordAdjustment, recordWaste } from "@/modules/inventory/services/stock-operations";
import { createTransfer, receiveTransfer, sendTransfer } from "@/modules/inventory/services/transfer-service";
import { withTransaction } from "@/db/transactions/transaction-context";

import { allowNegativeInventory, createInventoryScenario, post, stockedItem, type InventoryScenario } from "../../fixtures/inventory-fixtures";
import { newKey } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

// Phase 37 (policies 2–8): items costed by lot. Stock leaving is costed from the lots it left;
// a lot's value moves with its quantity; switching method carries the value over; shortfalls
// leave their difference on the lot that covers them; transfers carry exact value.
describe("lot costing (Phase 37)", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const version = async (inventoryItemId: string) =>
    (await database().select({ version: inventoryItems.version }).from(inventoryItems).where(eq(inventoryItems.id, inventoryItemId)))[0]!.version;

  /** A lot-tracked item at A and B. */
  async function trackedItem() {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each, alsoAt: [scenario.adminAtB] });
    await enableLotTracking(database(), scenario.admin, item.id, item.version);

    return item;
  }

  async function lotCosted(inventoryItemId: string) {
    return changeCostingMethod(database(), scenario.admin, inventoryItemId, {
      method: "LOT",
      reasonCode: "SUPPLIER_PRICES_VARY",
      expectedVersion: await version(inventoryItemId),
    });
  }

  const receive = (inventoryItemId: string, quantity: string, totalCost: string, expiresOn: string | null, locationId?: string) =>
    post(database(), scenario.admin, {
      inventoryItemId,
      type: "RECEIVE",
      quantity,
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: totalCost,
      lot: { expiresOn, supplierLotCode: null },
      ...(locationId ? { locationId } : {}),
    });

  const lotsOf = (inventoryItemId: string, locationId = scenario.locationA) =>
    database()
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.inventoryItemId, inventoryItemId), eq(inventoryLots.locationId, locationId)))
      .orderBy(asc(inventoryLots.sequenceNumber));

  const balanceOf = async (inventoryItemId: string, locationId = scenario.locationA) =>
    (
      await database()
        .select()
        .from(inventoryBalances)
        .where(and(eq(inventoryBalances.inventoryItemId, inventoryItemId), eq(inventoryBalances.locationId, locationId)))
    )[0]!;

  const ledger = (inventoryItemId: string, locationId = scenario.locationA) =>
    database()
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.inventoryItemId, inventoryItemId), eq(inventoryTransactions.locationId, locationId)))
      .orderBy(asc(inventoryTransactions.sequence));

  const sound = async () => {
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLots(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLotValues(database(), scenario.organizationId)).toEqual([]);
  };

  it("needs lot tracking, carries the value over both ways, records each change and audits it", async () => {
    const plain = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    await expect(lotCosted(plain.id)).rejects.toMatchObject({ code: "LOT_COSTING_NEEDS_LOTS" });

    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each, alsoAt: [scenario.adminAtB] });
    await receive(item.id, "4", "4.00", null);
    await receive(item.id, "2", "3.00", null);
    // Weighted average: (4 + 3) / 6 = 1.1667.
    expect((await balanceOf(item.id)).weightedAverageCost).toBe("1.1667");
    await enableLotTracking(database(), scenario.admin, item.id, await version(item.id));

    const switched = await lotCosted(item.id);
    expect(switched.costingMethod).toBe("LOT");
    const [opening] = await lotsOf(item.id);
    // The opening lot is carried at the average; its value is 6 x 1.1667.
    expect(opening).toMatchObject({ origin: "OPENING", carryingUnitCost: "1.1667", valueRemaining: "7.0002" });
    expect((await balanceOf(item.id)).stockValue).toBe("7.0002");

    const changes = await database().select().from(inventoryCostingChanges).where(eq(inventoryCostingChanges.inventoryItemId, item.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      fromMethod: "WEIGHTED_AVERAGE",
      toMethod: "LOT",
      quantityOnHand: "6.0000",
      valueBefore: "7.0002",
      valueAfter: "7.0002",
      reasonCode: "SUPPLIER_PRICES_VARY",
    });
    const [audit] = await database().select().from(auditEvents).where(and(eq(auditEvents.action, "inventory.costing-method-changed"), eq(auditEvents.entityId, item.id)));
    expect(audit!.after).toMatchObject({ costingMethod: "LOT", reasonCode: "SUPPLIER_PRICES_VARY" });
    expect(JSON.stringify(audit!.after)).not.toMatch(/7\.0002|1\.1667/);

    // Records can't be changed or removed.
    await expect(database().execute(sql`UPDATE inventory_costing_changes SET reason_code = 'OTHER' WHERE id = ${changes[0]!.id}`)).rejects.toThrow();
    await expect(database().execute(sql`DELETE FROM inventory_costing_changes WHERE id = ${changes[0]!.id}`)).rejects.toThrow();

    // Lot tracking stays on while the item is costed by lot.
    await expect(disableLotTracking(database(), scenario.admin, item.id, switched.version)).rejects.toMatchObject({ code: "LOT_COSTING_ACTIVE" });
    await expect(lotCosted(item.id)).rejects.toMatchObject({ code: "COSTING_METHOD_UNCHANGED" });
    await sound();

    // A dearer delivery, then back to weighted average: the average is the lots' value / quantity.
    await receive(item.id, "4", "10.00", null);
    const back = await changeCostingMethod(database(), scenario.admin, item.id, {
      method: "WEIGHTED_AVERAGE",
      reasonCode: "CORRECTION",
      expectedVersion: switched.version,
    });
    expect(back.costingMethod).toBe("WEIGHTED_AVERAGE");
    const balance = await balanceOf(item.id);
    expect(balance).toMatchObject({ stockValue: null, weightedAverageCost: "1.7000" });
    expect((await lotsOf(item.id)).every((lot) => lot.carryingUnitCost === null && lot.valueRemaining === null)).toBe(true);
    await sound();
  });

  it("costs a removal from the lots it takes, first to expire first, and keeps value with quantity", async () => {
    const cheese = await trackedItem();
    await lotCosted(cheese.id);
    await receive(cheese.id, "10", "20.00", "2026-12-20");
    await receive(cheese.id, "4", "4.00", "2026-12-10");

    await recordWaste(database(), scenario.admin, {
      inventoryItemId: cheese.id,
      quantity: "6",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
      notes: null,
    });

    const waste = (await ledger(cheese.id)).at(-1)!;
    // 4 at 1.00 from the lot expiring first, then 2 at 2.00.
    expect(waste).toMatchObject({ transactionType: "WASTE", totalCost: "8.0000", unitCost: "1.3333", stockValueAfter: "16.0000", averageCostAfter: "2.0000" });
    const movements = await database().select().from(inventoryLotMovements).where(eq(inventoryLotMovements.inventoryTransactionId, waste.id));
    expect(movements.map((row) => [row.baseQuantityDelta, row.unitCost, row.totalCost]).sort()).toEqual([
      ["-2.0000", "2.0000", "4.0000"],
      ["-4.0000", "1.0000", "4.0000"],
    ]);
    expect((await lotsOf(cheese.id)).map((lot) => [lot.quantityRemaining, lot.valueRemaining])).toEqual([
      ["8.0000", "16.0000"],
      ["0.0000", "0.0000"],
    ]);
    await sound();
  });

  it("takes the whole remaining value with the last of a lot, so rounding never strands value", async () => {
    const oil = await trackedItem();
    await lotCosted(oil.id);
    // 3 for 10.00: carried at 3.3333.
    await receive(oil.id, "3", "10.00", null);

    for (const quantity of ["1", "1", "1"]) {
      await recordWaste(database(), scenario.admin, { inventoryItemId: oil.id, quantity, unitOfMeasureId: scenario.units.each, reasonCode: "OTHER", notes: null });
    }

    expect((await ledger(oil.id)).filter((row) => row.transactionType === "WASTE").map((row) => row.totalCost)).toEqual(["3.3333", "3.3333", "3.3334"]);
    expect((await balanceOf(oil.id)).stockValue).toBe("0.0000");
    await sound();
  });

  it("costs a shortfall at the latest lot cost and stores the difference on the lot that covers it", async () => {
    const cheese = await trackedItem();
    await lotCosted(cheese.id);
    await allowNegativeInventory(database(), scenario.locationA, true);
    await receive(cheese.id, "6", "6.00", "2026-12-10");

    await post(database(), scenario.admin, { inventoryItemId: cheese.id, type: "CONSUME", quantity: "10", unitOfMeasureId: scenario.units.each });
    const consume = (await ledger(cheese.id)).at(-1)!;
    // 6 from the lot at 1.00 and 4 short at that same 1.00.
    expect(consume).toMatchObject({ totalCost: "10.0000", stockValueAfter: "-4.0000" });
    await sound();

    // The next delivery costs 1.50 each: covering the 4 takes 6.00 of it, 2.00 more than posted.
    await receive(cheese.id, "20", "30.00", "2026-12-30");
    const receipt = (await ledger(cheese.id)).at(-1)!;
    expect(receipt).toMatchObject({ totalCost: "30.0000", stockValueAfter: "24.0000" });
    const settled = await database()
      .select()
      .from(inventoryLotMovements)
      .where(and(eq(inventoryLotMovements.inventoryTransactionId, consume.id), sql`${inventoryLotMovements.costDifference} IS NOT NULL`));
    expect(settled.map((row) => [row.baseQuantityDelta, row.totalCost, row.costDifference])).toEqual([["-4.0000", "6.0000", "2.0000"]]);
    // The sale keeps its cost.
    const [again] = await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.id, consume.id));
    expect(again!.totalCost).toBe("10.0000");
    await sound();
    await allowNegativeInventory(database(), scenario.locationA, false);
  });

  it("refuses to start lot costing while a shortfall from before is open", async () => {
    const cheese = await trackedItem();
    await allowNegativeInventory(database(), scenario.locationA, true);
    await post(database(), scenario.admin, { inventoryItemId: cheese.id, type: "CONSUME", quantity: "2", unitOfMeasureId: scenario.units.each });
    await expect(lotCosted(cheese.id)).rejects.toMatchObject({ code: "LOT_COSTING_SHORTFALL_OPEN" });
    await receive(cheese.id, "5", "5.00", null);
    await expect(lotCosted(cheese.id)).resolves.toMatchObject({ costingMethod: "LOT" });
    await sound();
    await allowNegativeInventory(database(), scenario.locationA, false);
  });

  it("returns a sale reversal to the same lots at the cost it left at", async () => {
    const cheese = await trackedItem();
    await lotCosted(cheese.id);
    await receive(cheese.id, "2", "2.00", "2026-12-10");
    await receive(cheese.id, "5", "15.00", "2026-12-20");
    const consumed = await post(database(), scenario.admin, {
      inventoryItemId: cheese.id,
      type: "CONSUME",
      quantity: "3",
      unitOfMeasureId: scenario.units.each,
      reference: { type: "ORDER_ITEM", id: randomUUID() },
    });
    expect(consumed.totalCost).toBe("5.0000");

    await withTransaction(database(), (transaction) =>
      postSaleReversal(transaction, {
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        originalTransactionIds: [consumed.transactionId],
        voidId: randomUUID(),
        occurredAt: new Date(),
        createdByUserId: scenario.admin.userId,
      }),
    );
    const reversal = (await ledger(cheese.id)).at(-1)!;
    expect(reversal).toMatchObject({ transactionType: "SALE_REVERSAL", totalCost: "5.0000", stockValueAfter: "17.0000" });
    expect((await lotsOf(cheese.id)).map((lot) => [lot.quantityRemaining, lot.valueRemaining])).toEqual([
      ["2.0000", "2.0000"],
      ["5.0000", "15.0000"],
    ]);
    await sound();
  });

  it("brings found stock in at the cost of what is on hand", async () => {
    const cheese = await trackedItem();
    await lotCosted(cheese.id);
    await receive(cheese.id, "4", "10.00", null);
    await recordAdjustment(database(), scenario.admin, {
      inventoryItemId: cheese.id,
      quantity: "2",
      unitOfMeasureId: scenario.units.each,
      direction: "INCREASE",
      reasonCode: "FOUND_STOCK",
      expiresOn: null,
      notes: null,
    });
    expect((await ledger(cheese.id)).at(-1)).toMatchObject({ transactionType: "ADJUST_INCREASE", unitCost: "2.5000", totalCost: "5.0000", stockValueAfter: "15.0000" });
    await sound();
  });

  it("moves exactly the value sent between locations, lot by lot", async () => {
    const cheese = await trackedItem();
    await lotCosted(cheese.id);
    await receive(cheese.id, "3", "10.00", "2026-12-10");
    await receive(cheese.id, "10", "20.00", "2026-12-20");

    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: cheese.id, quantity: "5", unitOfMeasureId: scenario.units.each }],
    });
    const sent = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() });
    const [line] = await database().select().from(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, draft.id));
    // 3 for 10.00, then 2 at 2.00.
    expect(line).toMatchObject({ valueSent: "14.0000", unitCostSent: "2.8000" });
    await expect(database().execute(sql`UPDATE inventory_transfer_lines SET value_sent = 1 WHERE id = ${line!.id}`)).rejects.toThrow();

    await receiveTransfer(database(), scenario.adminAtB, draft.id, {
      expectedVersion: sent.version,
      idempotencyKey: newKey(),
      lines: [{ lineId: line!.id, quantityReceived: "5" }],
    });
    const arrived = (await ledger(cheese.id, scenario.locationB)).find((row) => row.transactionType === "TRANSFER_IN")!;
    expect(arrived).toMatchObject({ totalCost: "14.0000", stockValueAfter: "14.0000" });
    expect((await lotsOf(cheese.id, scenario.locationB)).map((lot) => [lot.quantityRemaining, lot.carryingUnitCost, lot.valueRemaining])).toEqual([
      ["3.0000", "3.3333", "10.0000"],
      ["2.0000", "2.0000", "4.0000"],
    ]);
    await sound();
  });

  it("leaves weighted-average items exactly as before", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "10", "20.00", "2026-12-20");
    await receive(cheese.id, "4", "4.00", "2026-12-10");
    await recordWaste(database(), scenario.admin, { inventoryItemId: cheese.id, quantity: "6", unitOfMeasureId: scenario.units.each, reasonCode: "SPOILAGE", notes: null });

    const waste = (await ledger(cheese.id)).at(-1)!;
    // (20 + 4) / 14 = 1.7143, whatever lots it came from.
    expect(waste).toMatchObject({ unitCost: "1.7143", totalCost: "10.2858", stockValueAfter: null });
    const movements = await database().select().from(inventoryLotMovements).where(eq(inventoryLotMovements.inventoryTransactionId, waste.id));
    expect(movements.every((row) => row.totalCost === null && row.unitCost === null)).toBe(true);
    expect((await lotsOf(cheese.id)).every((lot) => lot.carryingUnitCost === null)).toBe(true);
    expect((await balanceOf(cheese.id)).stockValue).toBeNull();
    await sound();
  });
});
