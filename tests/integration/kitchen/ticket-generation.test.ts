import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryTransactions, kitchenTicketItems, kitchenTickets, outboxEvents } from "@/db/schema";
import { updateItem } from "@/modules/menu/services/catalog-service";
import { updateModifier } from "@/modules/menu/services/modifier-service";
import { setItemRouting } from "@/modules/menu/services/prep-station-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import {
  createKitchenScenario,
  historyFor,
  outboxFor,
  sendOrder,
  ticketItemsForOrder,
  ticketsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { clearOrderData, newKey, onHand, orderRow, plainItem } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("kitchen ticket generation at SEND", () => {
  let scenario: KitchenScenario;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("routes burger, fries and cocktail to GRILL, FRY and BAR tickets with SEND snapshots", async () => {
    const { order, sent } = await sendOrder(database(), scenario, [
      {
        menuItemId: scenario.burger.menuItem.id,
        selections: scenario.burger.canonicalSelections,
        specialInstructions: "Cut in half",
      },
      { menuItemId: scenario.fries.id, quantity: 2 },
      { menuItemId: scenario.cocktail.id },
    ]);
    const tickets = await ticketsForOrder(database(), order.id);
    const items = await ticketItemsForOrder(database(), order.id);

    expect(sent.ticketIds).toHaveLength(3);
    expect(tickets.map((ticket) => ticket.prepStationId).sort()).toEqual(
      [scenario.stations.grill.id, scenario.stations.fry.id, scenario.stations.bar.id].sort(),
    );

    for (const ticket of tickets) {
      expect(ticket.sendBatchId).toBe(sent.batchId);
      expect(ticket.batchNumberSnapshot).toBe(1);
      expect(ticket.attemptNumber).toBe(1);
      expect(ticket.remakeId).toBeNull();
      expect(ticket.orderNumberSnapshot).toBe(order.orderNumber);
      expect(ticket.orderTypeSnapshot).toBe("DINE_IN");
      expect(ticket.tableLabelSnapshot).toMatch(/^T-/);
      expect(ticket.submittedAt.toISOString()).toBe(sent.sentAt);
    }

    const bar = tickets.find((ticket) => ticket.prepStationId === scenario.stations.bar.id)!;
    const grill = tickets.find((ticket) => ticket.prepStationId === scenario.stations.grill.id)!;

    expect(bar.stationTypeSnapshot).toBe("BAR");
    expect(grill.stationTypeSnapshot).toBe("KITCHEN");

    const burgerWork = items.find((item) => item.ticketId === grill.id)!;

    expect(burgerWork).toMatchObject({
      status: "NEW",
      quantity: 1,
      menuItemNameSnapshot: "Bacon Cheeseburger",
      kitchenInstructionsSnapshot: "Cook medium; No onion; Extra pickles; Swiss, not American; Cut in half",
      attemptNumber: 1,
    });
    expect((burgerWork.modifierSnapshots as { name: string }[]).map((modifier) => modifier.name)).toEqual([
      "Medium",
      "No Onion",
      "Extra Pickles",
      "Swiss instead of American",
    ]);
    expect(items.find((item) => item.menuItemNameSnapshot === "Fries")!.quantity).toBe(2);

    const history = await historyFor(database(), items.map((item) => item.id));

    expect(history).toHaveLength(3);
    expect(history.every((row) => row.status === "NEW" && row.changedByUserId === scenario.serverActor.userId)).toBe(
      true,
    );
  });

  it("writes outbox events inside the SEND transaction, unpublished until the processor runs", async () => {
    const { order, sent } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
      { menuItemId: scenario.cocktail.id },
    ]);
    const events = await outboxFor(database(), [order.id, ...sent.ticketIds]);

    expect(events.map((event) => event.eventType).sort()).toEqual([
      "kitchen.ticket-created",
      "kitchen.ticket-created",
      "order.items-submitted",
    ]);
    expect(events.every((event) => event.publishedAt === null)).toBe(true);
    expect(events.every((event) => event.locationId === scenario.locationA)).toBe(true);
    // Identifiers only: no price, cost or name travels in an event.
    expect(JSON.stringify(events.map((event) => event.payload))).not.toMatch(/price|cost|Margarita|Burger/i);
  });

  it("a replay with the same key creates no ticket, item, history or outbox row", async () => {
    const { order, sent, key } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
      { menuItemId: scenario.cocktail.id },
    ]);
    const before = {
      tickets: (await ticketsForOrder(database(), order.id)).length,
      items: (await ticketItemsForOrder(database(), order.id)).length,
      outbox: (await database().select().from(outboxEvents)).length,
    };
    const current = await orderRow(database(), order.id);
    const replay = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: current.version - 1,
      idempotencyKey: key,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.ticketIds).toEqual(sent.ticketIds);
    expect((await ticketsForOrder(database(), order.id)).length).toBe(before.tickets);
    expect((await ticketItemsForOrder(database(), order.id)).length).toBe(before.items);
    expect((await database().select().from(outboxEvents)).length).toBe(before.outbox);
  });

  it("database uniqueness refuses a second ticket for the same batch and station", async () => {
    const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }]);
    const [ticket] = await ticketsForOrder(database(), order.id);
    const copy = { ...ticket!, id: undefined, createdAt: undefined };

    await expect(database().insert(kitchenTickets).values(copy)).rejects.toThrow();
  });

  it("a shortage rolls SEND back with no tickets, items, history or outbox rows", async () => {
    const session = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT", customerName: null });
    const added = await addDraftItem(database(), scenario.serverActor, session.id, {
      expectedVersion: session.version,
      menuItemId: scenario.burger.menuItem.id,
      quantity: 60,
      selections: scenario.burger.mediumOnly,
      specialInstructions: null,
    });
    const outboxBefore = (await database().select().from(outboxEvents)).length;

    await expect(
      sendOrderItems(database(), scenario.serverActor, session.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(await ticketsForOrder(database(), session.id)).toHaveLength(0);
    expect(await ticketItemsForOrder(database(), session.id)).toHaveLength(0);
    expect((await database().select().from(outboxEvents)).length).toBe(outboxBefore);
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("100.0000");
  });

  it("an item routed to two stations gets work at both; EXPO and no route create none", async () => {
    const combo = await plainItem(database(), scenario.owner, "9.00", "Burger basket");
    const garnish = await plainItem(database(), scenario.owner, "1.00", "Garnish");
    const water = await plainItem(database(), scenario.owner, "0.00", "Water");

    await setItemRouting(database(), scenario.owner, combo.id, {
      prepStationIds: [scenario.stations.grill.id, scenario.stations.fry.id],
    });
    await setItemRouting(database(), scenario.owner, garnish.id, { prepStationIds: [scenario.stations.expo.id] });

    const { order } = await sendOrder(database(), scenario, [
      { menuItemId: combo.id },
      { menuItemId: garnish.id },
      { menuItemId: water.id },
    ]);
    const tickets = await ticketsForOrder(database(), order.id);
    const items = await ticketItemsForOrder(database(), order.id);

    expect(tickets.map((ticket) => ticket.prepStationId).sort()).toEqual(
      [scenario.stations.grill.id, scenario.stations.fry.id].sort(),
    );
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.menuItemNameSnapshot === "Burger basket")).toBe(true);
    expect(tickets.some((ticket) => ticket.prepStationId === scenario.stations.expo.id)).toBe(false);
  });

  it("each send round gets its own tickets; consumption is not repeated per station", async () => {
    const combo = await plainItem(database(), scenario.owner, "9.00", "Basket");

    await setItemRouting(database(), scenario.owner, combo.id, {
      prepStationIds: [scenario.stations.grill.id, scenario.stations.fry.id],
    });

    const { order, sent } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
    ]);
    const consumes = await database()
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.referenceId, sent.itemIds[0]!));

    expect(consumes.every((row) => row.transactionType === "CONSUME")).toBe(true);
    expect(consumes).toHaveLength(6);

    const current = await orderRow(database(), order.id);
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: current.version,
      menuItemId: scenario.cocktail.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });
    const second = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });
    const tickets = await ticketsForOrder(database(), order.id);

    expect(second.batchNumber).toBe(2);
    expect(tickets.map((ticket) => ticket.batchNumberSnapshot).sort()).toEqual([1, 2]);
  });

  it("takeout routes through the same stations with no table session", async () => {
    const { order } = await sendOrder(
      database(),
      scenario,
      [{ menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly }],
      { orderType: "TAKEOUT", customerName: "Sam" },
    );
    const [ticket] = await ticketsForOrder(database(), order.id);

    expect(ticket).toMatchObject({
      orderTypeSnapshot: "TAKEOUT",
      tableLabelSnapshot: null,
      pickupLabelSnapshot: "Sam",
      prepStationId: scenario.stations.grill.id,
    });
    expect((await orderRow(database(), order.id)).tableSessionId).toBeNull();
  });

  it("renaming the item or modifier, or rerouting, never changes sent work", async () => {
    const { order } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.canonicalSelections },
    ]);
    const before = await ticketItemsForOrder(database(), order.id);
    const ticketsBefore = await ticketsForOrder(database(), order.id);
    const menuItem = scenario.burger.menuItem;
    const medium = scenario.burger.modifiers.medium;

    await updateItem(database(), scenario.owner, menuItem.id, {
      name: "Renamed Burger",
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 0,
      active: true,
      available: true,
      expectedVersion: menuItem.version,
    });
    await updateModifier(database(), scenario.owner, medium.id, {
      name: "Renamed Medium",
      description: null,
      priceAdjustment: "0.00",
      preparationEffectType: "INSTRUCTION",
      preparationInstruction: "Changed instruction",
      active: true,
      expectedVersion: medium.version,
    });
    await setItemRouting(database(), scenario.owner, menuItem.id, { prepStationIds: [scenario.stations.fry.id] });

    expect(await ticketItemsForOrder(database(), order.id)).toEqual(before);
    expect(await ticketsForOrder(database(), order.id)).toEqual(ticketsBefore);

    // A new submission follows the new configuration.
    const { order: next } = await sendOrder(database(), scenario, [
      { menuItemId: menuItem.id, selections: scenario.burger.mediumOnly },
    ]);
    const [nextTicket] = await ticketsForOrder(database(), next.id);
    const [nextItem] = await ticketItemsForOrder(database(), next.id);

    expect(nextTicket!.prepStationId).toBe(scenario.stations.fry.id);
    expect(nextItem!.menuItemNameSnapshot).toBe("Renamed Burger");
  });

  it("the database refuses changes to a work item's snapshot and deletion", async () => {
    const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }]);
    const [item] = await ticketItemsForOrder(database(), order.id);

    await expect(
      database()
        .update(kitchenTicketItems)
        .set({ menuItemNameSnapshot: "Changed" })
        .where(eq(kitchenTicketItems.id, item!.id)),
    ).rejects.toThrow();
    await expect(
      database().delete(kitchenTicketItems).where(eq(kitchenTicketItems.id, item!.id)),
    ).rejects.toThrow();
    await expect(
      database()
        .update(kitchenTicketItems)
        .set({ status: "READY", readyAt: new Date(), readyByUserId: scenario.owner.userId, startedAt: new Date(), startedByUserId: scenario.owner.userId })
        .where(eq(kitchenTicketItems.id, item!.id)),
    ).rejects.toThrow();
    await expect(
      database().update(kitchenTickets).set({ tableLabelSnapshot: "X" }).where(eq(kitchenTickets.orderId, order.id)),
    ).rejects.toThrow();
  });
});
