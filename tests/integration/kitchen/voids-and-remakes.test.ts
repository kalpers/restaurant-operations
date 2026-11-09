import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryTransactions,
  kitchenRemakeConsumption,
  kitchenRemakes,
  orderItems,
} from "@/db/schema";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { addIngredient } from "@/modules/recipes/services/ingredient-service";
import { createDraftRevision, publishRevision } from "@/modules/recipes/services/recipe-service";
import { voidOrder, voidOrderItem } from "@/workflows/void-order-item/void-order-item";
import { remakeOrderItem } from "@/workflows/remake-order-item/remake-order-item";

import { allowNegativeInventory, post } from "../../fixtures/inventory-fixtures";
import {
  createKitchenScenario,
  historyFor,
  sendOrder,
  ticketItemsForOrder,
  ticketsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { clearOrderData, ledgerFor, newKey, onHand, orderRow, plainItem } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("fulfillment-aware voids and Remakes", () => {
  let scenario: KitchenScenario;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function canonicalBurger() {
    const sent = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.canonicalSelections },
    ]);
    const [work] = await ticketItemsForOrder(database(), sent.order.id);

    return { ...sent, orderItemId: sent.sent.itemIds[0]!, work: work! };
  }

  const voidItem = async (orderId: string, itemId: string, disposition: "UNPREPARED" | "PREPARED_OR_DISCARDED") =>
    voidOrderItem(database(), scenario.voidManager, orderId, itemId, {
      reason: "Guest changed mind",
      disposition,
      expectedVersion: (await orderRow(database(), orderId)).version,
    });

  const remake = (orderId: string, itemId: string, key = newKey(), reason = "Dropped on the floor") =>
    remakeOrderItem(database(), scenario.cook, orderId, itemId, { reason, idempotencyKey: key });

  const start = (item: { id: string; version: number }) =>
    transitionTicketItem(database(), scenario.cook, item.id, "start", { expectedVersion: item.version });

  it("UNPREPARED on NEW work cancels it and posts SALE_REVERSAL", async () => {
    const { order, orderItemId, work } = await canonicalBurger();

    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("92.0000");

    await voidItem(order.id, orderItemId, "UNPREPARED");

    const [after] = await ticketItemsForOrder(database(), order.id);

    expect(after!.status).toBe("CANCELLED");
    expect(after!.cancelledByUserId).toBe(scenario.voidManager.userId);
    expect((await historyFor(database(), [work.id])).map((row) => row.status)).toEqual(["NEW", "CANCELLED"]);
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("100.0000");
    expect((await ledgerFor(database(), scenario.burger.stock.beef.id)).map((row) => row.transactionType)).toEqual([
      "RECEIVE",
      "CONSUME",
      "SALE_REVERSAL",
    ]);
    // The cancelled ticket is still visible as history.
    expect(await ticketsForOrder(database(), order.id)).toHaveLength(1);
  });

  it("UNPREPARED is refused once preparation starts; PREPARED_OR_DISCARDED keeps all stock used", async () => {
    const { order, orderItemId, work } = await canonicalBurger();

    await start(work);
    await expect(voidItem(order.id, orderItemId, "UNPREPARED")).rejects.toMatchObject({
      code: "FULFILLMENT_ALREADY_STARTED",
    });

    // The refusal rolled back: still SUBMITTED, still PREPARING, stock unchanged.
    const [item] = await database().select().from(orderItems).where(eq(orderItems.id, orderItemId));

    expect(item!.status).toBe("SUBMITTED");
    expect((await ticketItemsForOrder(database(), order.id))[0]!.status).toBe("PREPARING");

    await voidItem(order.id, orderItemId, "PREPARED_OR_DISCARDED");

    expect((await ticketItemsForOrder(database(), order.id))[0]!.status).toBe("CANCELLED");
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("92.0000");

    const types = (
      await Promise.all(Object.values(scenario.burger.stock).map((stock) => ledgerFor(database(), stock.id)))
    )
      .flat()
      .map((row) => row.transactionType);

    expect(types).not.toContain("WASTE");
    expect(types).not.toContain("SALE_REVERSAL");
  });

  it("PREPARED_OR_DISCARDED keeps COMPLETED history and cancels only active attempts", async () => {
    const { order, orderItemId, work } = await canonicalBurger();
    const started = await start(work);
    const ready = await transitionTicketItem(database(), scenario.cook, work.id, "ready", {
      expectedVersion: started.version,
    });

    await transitionTicketItem(database(), scenario.cook, work.id, "complete", { expectedVersion: ready.version });
    await remake(order.id, orderItemId);
    await voidItem(order.id, orderItemId, "PREPARED_OR_DISCARDED");

    const items = await ticketItemsForOrder(database(), order.id);

    expect(items.map((item) => [item.attemptNumber, item.status])).toEqual([
      [1, "COMPLETED"],
      [2, "CANCELLED"],
    ]);
  });

  it("a Remake adds a linked attempt at every routed station and consumes again from the snapshot", async () => {
    const { order, orderItemId, work } = await canonicalBurger();
    const before = await orderRow(database(), order.id);
    const result = await remake(order.id, orderItemId);
    const items = await ticketItemsForOrder(database(), order.id);
    const tickets = await ticketsForOrder(database(), order.id);

    expect(result.attemptNumber).toBe(2);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      attemptNumber: 2,
      status: "NEW",
      menuItemNameSnapshot: work.menuItemNameSnapshot,
      kitchenInstructionsSnapshot: work.kitchenInstructionsSnapshot,
      prepStationId: work.prepStationId,
    });
    expect(items[1]!.modifierSnapshots).toEqual(work.modifierSnapshots);
    expect(tickets[1]).toMatchObject({ remakeId: result.remakeId, attemptNumber: 2, sendBatchId: tickets[0]!.sendBatchId });
    // The original attempt is untouched.
    expect(items[0]).toEqual(work);

    const [row] = await database().select().from(kitchenRemakes).where(eq(kitchenRemakes.id, result.remakeId));

    expect(row).toMatchObject({
      orderItemId,
      sourceTicketItemId: work.id,
      reason: "Dropped on the floor",
      requestedByUserId: scenario.cook.userId,
    });

    // Exact second consumption: beef 8, bun 1, Swiss 1, pickles 5, bacon 2.
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("84.0000");
    expect(await onHand(database(), scenario.burger.stock.pickles.id)).toBe("90.0000");
    expect(await onHand(database(), scenario.burger.stock.american.id)).toBe("100.0000");

    const consumption = await database()
      .select()
      .from(kitchenRemakeConsumption)
      .where(eq(kitchenRemakeConsumption.remakeId, result.remakeId));

    expect(consumption).toHaveLength(5);

    const remakeLedger = await database()
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.referenceType, "KITCHEN_REMAKE"), eq(inventoryTransactions.referenceId, result.remakeId)));

    expect(remakeLedger).toHaveLength(5);
    expect(remakeLedger.every((entry) => entry.transactionType === "CONSUME" && entry.createdByUserId === scenario.cook.userId)).toBe(true);

    // No charge: price, totals and the order version are unchanged; no new order item.
    const after = await orderRow(database(), order.id);

    expect(after.subtotal).toBe(before.subtotal);
    expect(after.version).toBe(before.version);
    expect(await database().select().from(orderItems).where(eq(orderItems.orderId, order.id))).toHaveLength(1);
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
  });

  it("a Remake uses the original snapshot even after the recipe changes", async () => {
    const { order, orderItemId } = await canonicalBurger();
    const owner = scenario.owner;
    const draft = await createDraftRevision(database(), owner, scenario.burger.recipe.id, {
      yieldQuantity: "1",
      yieldUnitId: scenario.units.each,
      preparationNotes: null,
    });
    const added = await addIngredient(database(), owner, scenario.burger.recipe.id, draft.id, {
      inventoryItemId: scenario.burger.stock.beef.id,
      quantity: "2",
      unitOfMeasureId: scenario.units.lb,
      preparationNote: null,
      sortOrder: 0,
      expectedVersion: draft.version,
    });

    await publishRevision(database(), owner, scenario.burger.recipe.id, draft.id, {
      effectiveFrom: null,
      expectedVersion: added.revisionVersion,
    });
    await remake(order.id, orderItemId);

    // Still 8 OZ of beef, not the new recipe's 32.
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("84.0000");
  });

  it("a retried Remake with the same key adds nothing", async () => {
    const { order, orderItemId } = await canonicalBurger();
    const key = newKey();
    const first = await remake(order.id, orderItemId, key);
    const again = await remake(order.id, orderItemId, key);

    expect(again.replayed).toBe(true);
    expect(again.remakeId).toBe(first.remakeId);
    expect(await ticketItemsForOrder(database(), order.id)).toHaveLength(2);
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("84.0000");
    await expect(remake(order.id, orderItemId, key, "Other reason")).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("a Remake that would run out of stock rolls back entirely", async () => {
    const { order, orderItemId } = await canonicalBurger();

    // Use most of the bacon: 100 received, 2 sent; take 97 more as waste.
    await post(database(), scenario.owner, {
      inventoryItemId: scenario.burger.stock.bacon.id,
      type: "WASTE",
      quantity: "97",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
    });

    await expect(remake(order.id, orderItemId)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await ticketItemsForOrder(database(), order.id)).toHaveLength(1);
    expect(await database().select().from(kitchenRemakes).where(eq(kitchenRemakes.orderItemId, orderItemId))).toHaveLength(0);
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("92.0000");
  });

  it("a Remake follows the Location's negative-stock policy", async () => {
    const { order, orderItemId } = await canonicalBurger();

    await post(database(), scenario.owner, {
      inventoryItemId: scenario.burger.stock.bacon.id,
      type: "WASTE",
      quantity: "97",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
    });
    await allowNegativeInventory(database(), scenario.locationA, true);

    try {
      await remake(order.id, orderItemId);
      expect(await onHand(database(), scenario.burger.stock.bacon.id)).toBe("-1.0000");
    } finally {
      await allowNegativeInventory(database(), scenario.locationA, false);
    }
  });

  it("UNPREPARED after a Remake reverses both the original and the Remake consumption", async () => {
    const { order, orderItemId } = await canonicalBurger();

    await remake(order.id, orderItemId);
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("84.0000");

    await voidItem(order.id, orderItemId, "UNPREPARED");

    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("100.0000");
    expect((await ticketItemsForOrder(database(), order.id)).map((item) => item.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);

    const reversals = (await ledgerFor(database(), scenario.burger.stock.beef.id)).filter(
      (row) => row.transactionType === "SALE_REVERSAL",
    );

    expect(reversals).toHaveLength(2);
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
  });

  it("refuses a Remake of a voided item, an item with no station work, and a blank reason", async () => {
    const { order, orderItemId } = await canonicalBurger();
    const water = await plainItem(database(), scenario.owner, "0.00", "Water");
    const { order: plain, sent } = await sendOrder(database(), scenario, [{ menuItemId: water.id }]);

    await expect(remake(plain.id, sent.itemIds[0]!)).rejects.toMatchObject({ code: "NO_STATION_WORK" });
    await expect(remake(order.id, orderItemId, newKey(), "   ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await voidItem(order.id, orderItemId, "UNPREPARED");
    await expect(remake(order.id, orderItemId)).rejects.toMatchObject({ code: "ITEM_NOT_SUBMITTED" });
  });

  it("a full order void synchronizes every item's station work", async () => {
    const { order, sent } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.fries.id },
      { menuItemId: scenario.cocktail.id },
    ]);
    const items = await ticketItemsForOrder(database(), order.id);
    const cocktail = items.find((item) => item.menuItemNameSnapshot === "Margarita")!;

    await transitionTicketItem(database(), scenario.bartender, cocktail.id, "start", {
      expectedVersion: cocktail.version,
    });

    const dispositions = Object.fromEntries(
      sent.itemIds.map((id) => [id, id === cocktail.orderItemId ? "PREPARED_OR_DISCARDED" : "UNPREPARED"] as const),
    );

    await voidOrder(database(), scenario.voidManager, order.id, {
      reason: "Walked out",
      expectedVersion: (await orderRow(database(), order.id)).version,
      dispositions,
    });

    expect((await ticketItemsForOrder(database(), order.id)).every((item) => item.status === "CANCELLED")).toBe(true);
    expect((await orderRow(database(), order.id)).status).toBe("VOIDED");
  });
});
