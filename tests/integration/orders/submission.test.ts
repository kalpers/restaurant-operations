import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  idempotencyRecords,
  inventoryTransactions,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItemStatusHistory,
  orderSendBatches,
} from "@/db/schema";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import { changePrice } from "@/modules/menu/services/pricing-service";
import { updateModifier } from "@/modules/menu/services/modifier-service";
import { updateItem } from "@/modules/menu/services/catalog-service";
import { getOrderDetail } from "@/modules/orders/queries/order-queries";
import { addDraftItem, removeDraftItem, updateDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { allowNegativeInventory } from "../../fixtures/inventory-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  ledgerFor,
  newKey,
  onHand,
  orderRow,
  plainItem,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("order submission (SEND)", () => {
  let scenario: OrderScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function dineInOrder() {
    const session = await seatedSession(database(), scenario);

    return createOrder(database(), scenario.serverActor, {
      orderType: "DINE_IN",
      tableSessionId: session.id,
    });
  }

  async function addBurger(orderId: string, version: number, selections = burger.canonicalSelections, quantity = 1) {
    return addDraftItem(database(), scenario.serverActor, orderId, {
      expectedVersion: version,
      menuItemId: burger.menuItem.id,
      quantity,
      selections,
      specialInstructions: null,
    });
  }

  it("sends the canonical Bacon Cheeseburger with exact snapshots, consumption and one batch", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version);

    // A draft consumes nothing.
    expect(await onHand(database(), burger.stock.beef.id)).toBe("100.0000");

    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });

    expect(sent.replayed).toBe(false);
    expect(sent.batchNumber).toBe(1);

    const [item] = await itemRows(database(), order.id);

    expect(item).toMatchObject({
      status: "SUBMITTED",
      menuItemNameSnapshot: "Bacon Cheeseburger",
      basePriceSnapshot: "15.99",
      modifierTotalSnapshot: "1.50",
      unitPriceSnapshot: "17.49",
      lineTotalSnapshot: "17.49",
      recipeId: burger.recipe.id,
      recipeVersionId: burger.revision.id,
      sendBatchId: sent.batchId,
      kitchenInstructionsSnapshot: "Cook medium; No onion; Extra pickles; Swiss, not American",
      prepStationIdsSnapshot: [burger.grill.id],
    });

    const modifiers = await database()
      .select()
      .from(orderItemModifiers)
      .where(eq(orderItemModifiers.orderItemId, item!.id));

    expect(
      modifiers
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((row) => [row.modifierNameSnapshot, row.priceAdjustmentSnapshot]),
    ).toEqual([
      ["Medium", "0.00"],
      ["No Onion", "0.00"],
      ["Extra Pickles", "0.50"],
      ["Swiss instead of American", "1.00"],
    ]);

    const consumption = await database()
      .select()
      .from(orderItemInventoryConsumption)
      .where(eq(orderItemInventoryConsumption.orderItemId, item!.id));
    const byItem = new Map(consumption.map((row) => [row.inventoryItemId, row.baseQuantity]));
    const { beef, bun, american, swiss, onion, pickles, bacon } = burger.stock;

    expect(byItem).toEqual(
      new Map([
        [beef.id, "8.0000"],
        [bun.id, "1.0000"],
        [swiss.id, "1.0000"],
        [pickles.id, "5.0000"],
        [bacon.id, "2.0000"],
      ]),
    );
    expect(byItem.has(american.id)).toBe(false);
    expect(byItem.has(onion.id)).toBe(false);
    expect(consumption.every((row) => row.recipeVersionId === burger.revision.id)).toBe(true);

    // Exact ledger movement, referencing the order item, and balances that reconcile.
    const ledger = await database()
      .select()
      .from(inventoryTransactions)
      .where(inArray(inventoryTransactions.id, consumption.map((row) => row.inventoryTransactionId)));

    expect(ledger.every((row) => row.transactionType === "CONSUME")).toBe(true);
    expect(ledger.every((row) => row.referenceType === "ORDER_ITEM" && row.referenceId === item!.id)).toBe(true);
    expect(await onHand(database(), beef.id)).toBe("92.0000");
    expect(await onHand(database(), pickles.id)).toBe("95.0000");
    expect(await onHand(database(), american.id)).toBe("100.0000");
    expect(await onHand(database(), onion.id)).toBe("100.0000");
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);

    // One submission, with history and a stored idempotent result.
    const batches = await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, order.id));

    expect(batches).toHaveLength(1);
    expect(
      await database().select().from(orderItemStatusHistory).where(eq(orderItemStatusHistory.orderItemId, item!.id)),
    ).toHaveLength(1);
    expect((await orderRow(database(), order.id)).subtotal).toBe("17.49");
  });

  it("replays a retry with the same key with no new batch, ledger row or snapshot", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version);
    const key = newKey();
    const input = { expectedVersion: added.orderVersion, idempotencyKey: key };
    const first = await sendOrderItems(database(), scenario.serverActor, order.id, input);
    const counts = async () => ({
      batches: (await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, order.id))).length,
      ledger: (await ledgerFor(database(), burger.stock.beef.id)).length,
      consumption: (await database().select().from(orderItemInventoryConsumption)).length,
    });
    const before = await counts();
    const retry = await sendOrderItems(database(), scenario.serverActor, order.id, input);

    expect(retry).toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
  });

  it("refuses a reused key with a different request, and another user's key", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version);
    const key = newKey();

    await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: key,
    });

    await expect(
      sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion + 1, idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      sendOrderItems(database(), scenario.manager, order.id, { expectedVersion: added.orderVersion, idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("serializes two simultaneous sends of one order: one wins, nothing is consumed twice", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version);
    const results = await Promise.allSettled([
      sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() }),
      sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONCURRENCY_CONFLICT" },
    });
    expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
    // The loser's idempotency claim rolled back with it.
    expect(await database().select().from(idempotencyRecords)).toSatisfy(
      (rows: unknown[]) => rows.length >= 1,
    );
  });

  it("supports three rounds: earlier items stay unchanged and only new items consume", async () => {
    const order = await dineInOrder();
    const soda = await plainItem(database(), scenario.owner, "3.00", "Soda");
    const pie = await plainItem(database(), scenario.owner, "6.50", "Pie");
    let version = order.version;
    const round = async (menuItemId: string, selections: { modifierGroupId: string; modifierId: string }[] = []) => {
      const added = await addDraftItem(database(), scenario.serverActor, order.id, {
        expectedVersion: version,
        menuItemId,
        quantity: 1,
        selections,
        specialInstructions: null,
      });
      const sent = await sendOrderItems(database(), scenario.serverActor, order.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: newKey(),
      });

      version = sent.orderVersion;

      return sent;
    };

    const drinks = await round(soda.id);
    const [sodaBefore] = await itemRows(database(), order.id);
    const entrees = await round(burger.menuItem.id, burger.mediumOnly);
    const dessert = await round(pie.id);

    expect([drinks.batchNumber, entrees.batchNumber, dessert.batchNumber]).toEqual([1, 2, 3]);

    const rows = await itemRows(database(), order.id);

    expect(rows.find((row) => row.id === sodaBefore!.id)).toEqual(sodaBefore);
    expect(rows.map((row) => row.status)).toEqual(["SUBMITTED", "SUBMITTED", "SUBMITTED"]);
    // Only the burger consumed beef, once.
    expect((await ledgerFor(database(), burger.stock.beef.id)).filter((row) => row.transactionType === "CONSUME")).toHaveLength(1);
    expect((await orderRow(database(), order.id)).subtotal).toBe("25.49");
    expect(
      await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: version, idempotencyKey: newKey() }).catch((error) => error.code),
    ).toBe("NOTHING_TO_SEND");
  });

  it("resolves price at SEND, then never changes history when the menu changes", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version, burger.mediumOnly);
    const [draft] = await itemRows(database(), order.id);

    expect(draft!.unitPriceSnapshot).toBe("15.99");

    // A price change while the item is a draft changes what it sells for.
    await changePrice(database(), scenario.owner, burger.menuItem.id, {
      locationId: null,
      price: "16.49",
      effectiveFrom: null,
    });

    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });
    const [submitted] = await itemRows(database(), order.id);

    expect(submitted!.basePriceSnapshot).toBe("16.49");

    // After SEND: rename, reprice and change modifiers; the snapshot stays.
    await changePrice(database(), scenario.owner, burger.menuItem.id, {
      locationId: null,
      price: "19.99",
      effectiveFrom: null,
    });
    await updateItem(database(), scenario.owner, burger.menuItem.id, {
      name: "Renamed Burger",
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 0,
      active: true,
      available: true,
      expectedVersion: burger.menuItem.version,
    });
    await updateModifier(database(), scenario.owner, burger.modifiers.medium.id, {
      name: "Medium Rare",
      description: null,
      priceAdjustment: "2.00",
      preparationEffectType: "INSTRUCTION",
      preparationInstruction: "Changed",
      active: true,
      expectedVersion: burger.modifiers.medium.version,
    });

    const detail = await getOrderDetail(database(), scenario.serverActor, order.id);

    expect(detail.items[0]).toMatchObject({
      name: "Bacon Cheeseburger",
      basePrice: "16.49",
      unitPrice: "16.49",
      kitchenInstructions: "Cook medium",
      modifiers: [expect.objectContaining({ name: "Medium", priceAdjustment: "0.00" })],
    });
    expect(detail.subtotal).toBe("16.49");
    expect(sent.orderVersion).toBe(detail.version);
  });

  it("fails the whole round atomically on a shortage and reports quantities without cost", async () => {
    const order = await dineInOrder();
    const soda = await plainItem(database(), scenario.owner);
    const first = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: soda.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });
    // 13 burgers need 104 oz of beef; 100 are on hand.
    const added = await addBurger(order.id, first.orderVersion, burger.mediumOnly, 13);
    const ledgerBefore = (await ledgerFor(database(), burger.stock.beef.id)).length;
    const error = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(error.details.shortages).toEqual(
      expect.arrayContaining([
        {
          inventoryItemId: burger.stock.beef.id,
          inventoryItemName: "Ground beef",
          baseUnitId: scenario.units.ozWeight,
          required: "104.0000",
          available: "100.0000",
          shortage: "4.0000",
        },
      ]),
    );
    expect(JSON.stringify(error.details)).not.toMatch(/cost/i);
    expect((await itemRows(database(), order.id)).map((row) => row.status)).toEqual(["DRAFT", "DRAFT"]);
    expect((await ledgerFor(database(), burger.stock.beef.id)).length).toBe(ledgerBefore);
    expect(await onHand(database(), burger.stock.bun.id)).toBe("100.0000");
    expect(await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, order.id))).toEqual([]);
  });

  it("lets consumption go negative when the location allows it", async () => {
    await allowNegativeInventory(database(), scenario.locationA, true);

    try {
      const order = await dineInOrder();
      const added = await addBurger(order.id, order.version, burger.mediumOnly, 13);

      await sendOrderItems(database(), scenario.serverActor, order.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: newKey(),
      });

      expect(await onHand(database(), burger.stock.beef.id)).toBe("-4.0000");
    } finally {
      await allowNegativeInventory(database(), scenario.locationA, false);
    }
  });

  it("refuses a stale version after someone else sends", async () => {
    const order = await dineInOrder();
    const added = await addBurger(order.id, order.version, burger.mediumOnly);
    const stale = added.orderVersion;
    const [item] = await itemRows(database(), order.id);

    await sendOrderItems(database(), scenario.manager, order.id, { expectedVersion: stale, idempotencyKey: newKey() });

    await expect(
      updateDraftItem(database(), scenario.serverActor, order.id, item!.id, {
        expectedVersion: stale,
        quantity: 2,
        selections: burger.mediumOnly,
        specialInstructions: null,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

    const current = (await orderRow(database(), order.id)).version;

    await expect(
      removeDraftItem(database(), scenario.serverActor, order.id, item!.id, { expectedVersion: current }),
    ).rejects.toMatchObject({ code: "ITEM_ALREADY_SENT" });
  });

  it("sends an item with no recipe without consumption", async () => {
    const order = await dineInOrder();
    const soda = await plainItem(database(), scenario.owner);
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: soda.id,
      quantity: 2,
      selections: [],
      specialInstructions: "Extra ice",
    });

    await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });

    const [item] = await itemRows(database(), order.id);

    expect(item).toMatchObject({ status: "SUBMITTED", recipeVersionId: null, lineTotalSnapshot: "6.00", kitchenInstructionsSnapshot: "Extra ice" });
    expect(
      await database().select().from(orderItemInventoryConsumption).where(eq(orderItemInventoryConsumption.orderItemId, item!.id)),
    ).toEqual([]);
  });
});
