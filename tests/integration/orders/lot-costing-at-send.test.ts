import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, inventoryItems, inventoryLotMovements, inventoryTransactions, orderItemInventoryConsumption } from "@/db/schema";
import { reconcileBalances, reconcileLots, reconcileLotValues } from "@/modules/inventory/queries/stock-queries";
import { changeCostingMethod } from "@/modules/inventory/services/costing-method-service";
import { enableLotTracking } from "@/modules/inventory/services/lot-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { post } from "../../fixtures/inventory-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  newKey,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

// Phase 37 (policies 4 and 5): the canonical Bacon Cheeseburger with Swiss costed by lot. SEND
// costs the slice from the lot it takes (a cheap dated delivery, not the average); the
// consumption snapshot is unchanged; a retry posts nothing; a void as never prepared returns
// the slice to its lot at the same cost.
describe("lot costing at SEND (Phase 37)", () => {
  let scenario: OrderScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    const swissVersion = async () =>
      (await database().select({ version: inventoryItems.version }).from(inventoryItems).where(eq(inventoryItems.id, burger.stock.swiss.id)))[0]!.version;

    await enableLotTracking(database(), scenario.owner, burger.stock.swiss.id, await swissVersion());
    await changeCostingMethod(database(), scenario.owner, burger.stock.swiss.id, {
      method: "LOT",
      reasonCode: "SUPPLIER_PRICES_VARY",
      expectedVersion: await swissVersion(),
    });
    // Three slices at 0.10 each, expiring before the opening stock.
    await post(database(), scenario.owner, {
      inventoryItemId: burger.stock.swiss.id,
      type: "RECEIVE",
      quantity: "3",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "0.30",
      lot: { expiresOn: "2026-12-01", supplierLotCode: "SWISS-7" },
    });
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const swissConsumes = () =>
    database()
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.inventoryItemId, burger.stock.swiss.id), eq(inventoryTransactions.transactionType, "CONSUME")));

  it("costs the slice from its lot, once, and a void returns it at that cost", async () => {
    const order = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" });
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.canonicalSelections,
      specialInstructions: null,
    });
    const input = { expectedVersion: added.orderVersion, idempotencyKey: newKey() };
    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, input);
    const [item] = await itemRows(database(), order.id);

    const consumption = await database()
      .select()
      .from(orderItemInventoryConsumption)
      .where(and(eq(orderItemInventoryConsumption.orderItemId, item!.id), eq(orderItemInventoryConsumption.inventoryItemId, burger.stock.swiss.id)));
    expect(consumption.map((row) => row.baseQuantity)).toEqual(["1.0000"]);

    const [consume] = await swissConsumes();
    expect(consume).toMatchObject({ baseQuantityDelta: "-1.0000", unitCost: "0.1000", totalCost: "0.1000" });
    const movements = await database().select().from(inventoryLotMovements).where(eq(inventoryLotMovements.inventoryTransactionId, consume!.id));
    expect(movements.map((row) => [row.baseQuantityDelta, row.totalCost])).toEqual([["-1.0000", "0.1000"]]);

    // A retry with the same key posts nothing: no ledger row, movement or cost.
    expect(await sendOrderItems(database(), scenario.serverActor, order.id, input)).toEqual({ ...sent, replayed: true });
    expect(await swissConsumes()).toHaveLength(1);
    expect(
      await database().select({ id: inventoryLotMovements.id }).from(inventoryLotMovements).where(inArray(inventoryLotMovements.inventoryTransactionId, [consume!.id])),
    ).toHaveLength(1);

    const valueBefore = (await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, burger.stock.swiss.id)))[0]!.stockValue;
    await voidOrderItem(database(), scenario.manager, order.id, item!.id, {
      reason: "Guest changed mind",
      disposition: "UNPREPARED",
      expectedVersion: sent.orderVersion,
    });
    const reversal = (
      await database()
        .select()
        .from(inventoryTransactions)
        .where(and(eq(inventoryTransactions.inventoryItemId, burger.stock.swiss.id), eq(inventoryTransactions.transactionType, "SALE_REVERSAL")))
    )[0]!;
    expect(reversal.totalCost).toBe("0.1000");
    const valueAfter = (await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, burger.stock.swiss.id)))[0]!.stockValue;
    expect(Number(valueAfter) - Number(valueBefore)).toBeCloseTo(0.1, 4);

    // Items not costed by lot (the beef, the bacon) are costed as before, at the average.
    const others = await database()
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.transactionType, "CONSUME"), eq(inventoryTransactions.inventoryItemId, burger.stock.beef.id)));
    expect(others.every((row) => row.stockValueAfter === null)).toBe(true);

    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLots(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLotValues(database(), scenario.organizationId)).toEqual([]);
  });
});
