import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryItems, inventoryLotMovements, inventoryLots, inventoryTransactions, inventoryTransferLines, locationSettings, notifications } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { reconcileBalances, reconcileLots } from "@/modules/inventory/queries/stock-queries";
import { correctLot, disableLotTracking, enableLotTracking, listLots, wasteLot } from "@/modules/inventory/services/lot-service";
import { recordAdjustment, recordWaste } from "@/modules/inventory/services/stock-operations";
import { createTransfer, receiveTransfer, sendTransfer } from "@/modules/inventory/services/transfer-service";
import { notifyTimeBasedSignals } from "@/workflows/notify-time-based-signals/notify-time-based-signals";

import { allowNegativeInventory, createInventoryScenario, post, stockedItem, type InventoryScenario } from "../../fixtures/inventory-fixtures";
import { newKey } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("ingredient lots (Phase 23)", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function trackedItem() {
    const item = await stockedItem(database(), scenario.admin, {
      baseUnitId: scenario.units.each,
      alsoAt: [scenario.adminAtB],
    });
    await enableLotTracking(database(), scenario.admin, item.id, item.version);

    return item;
  }

  const receive = (inventoryItemId: string, quantity: string, expiresOn: string | null, supplierLotCode: string | null = null, locationId?: string) =>
    post(database(), scenario.admin, {
      inventoryItemId,
      type: "RECEIVE",
      quantity,
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: quantity,
      lot: { expiresOn, supplierLotCode },
      ...(locationId ? { locationId } : {}),
    });

  const lotsOf = (inventoryItemId: string, locationId = scenario.locationA) =>
    database()
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.inventoryItemId, inventoryItemId), eq(inventoryLots.locationId, locationId)))
      .orderBy(asc(inventoryLots.sequenceNumber));

  const sound = async () => {
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLots(database(), scenario.organizationId)).toEqual([]);
  };

  it("creates a lot per receipt and takes the first to expire first", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "10", "2026-12-20", "SUP-B");
    await receive(cheese.id, "10", "2026-12-10", "SUP-A");

    const [late, soon] = await lotsOf(cheese.id);
    expect(late).toMatchObject({ lotNumber: expect.stringMatching(/^L-\d{6}$/), supplierLotCode: "SUP-B", origin: "RECEIPT", quantityRemaining: "10.0000" });
    expect(soon!.expiresOn).toBe("2026-12-10");

    await recordWaste(database(), scenario.admin, {
      inventoryItemId: cheese.id,
      quantity: "12",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
      notes: null,
    });

    const after = await lotsOf(cheese.id);
    expect(after.map((lot) => lot.quantityRemaining)).toEqual(["8.0000", "0.0000"]);
    await sound();
  });

  it("wastes a named lot, refuses one that holds too little, and corrects an expiry", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "5", "2026-12-10");
    await receive(cheese.id, "5", "2026-12-20");
    const [first, second] = await lotsOf(cheese.id);

    await expect(
      recordWaste(database(), scenario.admin, {
        inventoryItemId: cheese.id,
        lotId: second!.id,
        quantity: "6",
        unitOfMeasureId: scenario.units.each,
        reasonCode: "EXPIRED",
        notes: null,
      }),
    ).rejects.toMatchObject({ code: "LOT_INSUFFICIENT" });

    await wasteLot(database(), scenario.admin, second!.id, { notes: null });
    expect((await lotsOf(cheese.id)).map((lot) => lot.quantityRemaining)).toEqual(["5.0000", "0.0000"]);

    await correctLot(database(), scenario.admin, first!.id, {
      supplierLotCode: "FIXED",
      expiresOn: "2026-12-11",
      reason: "Misread the label",
      expectedVersion: first!.version,
    });
    const listed = await listLots(database(), scenario.admin, { inventoryItemId: cheese.id });
    expect(listed.lots).toHaveLength(1);
    expect(listed.lots[0]).toMatchObject({ supplierLotCode: "FIXED", expiresOn: "2026-12-11" });
    await sound();
  });

  it("opens a lot for stock already on hand, and refuses turning tracking off while lots hold stock", async () => {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each, alsoAt: [scenario.adminAtB] });
    await post(database(), scenario.admin, { inventoryItemId: item.id, type: "RECEIVE", quantity: "7", unitOfMeasureId: scenario.units.each, incomingTotalCost: "7" });
    await post(database(), scenario.admin, { inventoryItemId: item.id, type: "RECEIVE", quantity: "3", unitOfMeasureId: scenario.units.each, incomingTotalCost: "3", locationId: scenario.locationB });

    const enabled = await enableLotTracking(database(), scenario.admin, item.id, item.version);
    expect(enabled.openingLots).toBe(2);
    expect((await lotsOf(item.id))[0]).toMatchObject({ origin: "OPENING", quantityRemaining: "7.0000", expiresOn: null });
    await sound();

    await expect(disableLotTracking(database(), scenario.admin, item.id, enabled.version)).rejects.toMatchObject({ code: "LOTS_HAVE_STOCK" });

    for (const [actor, quantity] of [[scenario.admin, "7"], [scenario.adminAtB, "3"]] as const) {
      await recordWaste(database(), actor, { inventoryItemId: item.id, quantity, unitOfMeasureId: scenario.units.each, reasonCode: "OTHER", notes: null });
    }
    await disableLotTracking(database(), scenario.admin, item.id, enabled.version);
    const [row] = await database().select({ lotTracked: inventoryItems.lotTracked }).from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(row!.lotTracked).toBe(false);
  });

  it("records a shortfall where negative stock is allowed and settles it from the next receipt", async () => {
    const cheese = await trackedItem();
    await allowNegativeInventory(database(), scenario.locationA, true);
    await receive(cheese.id, "6", "2026-12-10");

    await post(database(), scenario.admin, { inventoryItemId: cheese.id, type: "CONSUME", quantity: "10", unitOfMeasureId: scenario.units.each });
    const consume = (
      await database().select().from(inventoryTransactions).where(and(eq(inventoryTransactions.inventoryItemId, cheese.id), eq(inventoryTransactions.transactionType, "CONSUME")))
    )[0]!;
    const before = await database().select().from(inventoryLotMovements).where(eq(inventoryLotMovements.inventoryTransactionId, consume.id));
    expect(before.map((movement) => [movement.lotId === null, movement.baseQuantityDelta]).sort()).toEqual([
      [false, "-6.0000"],
      [true, "-4.0000"],
    ]);
    await sound();

    await receive(cheese.id, "20", "2026-12-30");
    const lots = await lotsOf(cheese.id);
    expect(lots.map((lot) => lot.quantityRemaining)).toEqual(["0.0000", "16.0000"]);
    await sound();
    await allowNegativeInventory(database(), scenario.locationA, false);
  });

  it("sends lots with a transfer and recreates them at the other location", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "4", "2026-12-10", "A1");
    await receive(cheese.id, "10", "2026-12-20", "B2");

    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: cheese.id, quantity: "6", unitOfMeasureId: scenario.units.each }],
    });
    const sent = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() });
    const [line] = await database().select().from(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, draft.id));
    await receiveTransfer(database(), scenario.adminAtB, draft.id, {
      expectedVersion: sent.version,
      idempotencyKey: newKey(),
      lines: [{ lineId: line!.id, quantityReceived: "5" }],
    });

    const atA = await lotsOf(cheese.id);
    expect(atA.map((lot) => lot.quantityRemaining)).toEqual(["0.0000", "8.0000"]);
    const atB = await lotsOf(cheese.id, scenario.locationB);
    expect(atB.map((lot) => [lot.origin, lot.supplierLotCode, lot.expiresOn, lot.sourceLotId, lot.quantityReceived])).toEqual([
      ["TRANSFER", "A1", "2026-12-10", atA[0]!.id, "4.0000"],
      ["TRANSFER", "B2", "2026-12-20", atA[1]!.id, "2.0000"],
    ]);
    // The one short is taken first to expire at the receiver.
    expect(atB.map((lot) => lot.quantityRemaining)).toEqual(["3.0000", "2.0000"]);
    await sound();
  });

  it("makes a found lot from an increase, with an optional expiry", async () => {
    const cheese = await trackedItem();
    await recordAdjustment(database(), scenario.admin, {
      inventoryItemId: cheese.id,
      quantity: "2",
      unitOfMeasureId: scenario.units.each,
      direction: "INCREASE",
      reasonCode: "FOUND_STOCK",
      expiresOn: "2026-12-01",
      notes: null,
    });
    expect((await lotsOf(cheese.id))[0]).toMatchObject({ origin: "FOUND", expiresOn: "2026-12-01", quantityRemaining: "2.0000" });
    await sound();
  });

  it("warns inventory managers once as a lot nears expiry and once when it has expired", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "4", "2026-12-10");
    const [lot] = await lotsOf(cheese.id);
    const notices = () =>
      database()
        .select({ type: notifications.notificationType, recipient: notifications.recipientUserId, title: notifications.title })
        .from(notifications)
        .where(eq(notifications.inventoryLotId, lot!.id));
    const run = (iso: string) => notifyTimeBasedSignals(database(), new Date(iso), { locationIds: [scenario.locationA] });

    await run("2026-12-01T18:00:00Z");
    expect(await notices()).toEqual([]);

    await run("2026-12-09T18:00:00Z");
    await run("2026-12-09T19:00:00Z");
    const expiring = await notices();
    expect(expiring.length).toBeGreaterThan(0);
    expect(new Set(expiring.map((row) => row.recipient)).size).toBe(expiring.length);
    expect(expiring.every((row) => row.type === "LOT_EXPIRING" && row.title.startsWith("Expiring soon"))).toBe(true);
    expect(expiring.map((row) => row.recipient)).toContain(scenario.admin.userId);

    await run("2026-12-11T18:00:00Z");
    expect((await notices()).filter((row) => row.title.startsWith("Expired"))).toHaveLength(expiring.length);

    // Off at 0, and nothing for an empty lot.
    await database().update(locationSettings).set({ lotExpiryWarningDays: 0 }).where(eq(locationSettings.locationId, scenario.locationA));
    const other = await trackedItem();
    await receive(other.id, "1", "2026-12-10");
    await run("2026-12-12T18:00:00Z");
    const [otherLot] = await lotsOf(other.id);
    expect(await database().select().from(notifications).where(eq(notifications.inventoryLotId, otherLot!.id))).toEqual([]);
  });

  it("refuses lot movements that don't add up to their ledger row", async () => {
    const cheese = await trackedItem();
    await receive(cheese.id, "3", null);
    const [lot] = await lotsOf(cheese.id);
    const [ledger] = await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, cheese.id));

    await expect(
      withTransaction(database(), async (transaction) => {
        await transaction.insert(inventoryLotMovements).values({
          organizationId: scenario.organizationId,
          inventoryTransactionId: ledger!.id,
          lotId: lot!.id,
          baseQuantityDelta: "1",
        });
      }),
    ).rejects.toThrow();
    await expect(database().update(inventoryLotMovements).set({ baseQuantityDelta: "2" }).where(eq(inventoryLotMovements.lotId, lot!.id))).rejects.toThrow();
  });
});
