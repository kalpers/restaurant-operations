import { eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employees, inventoryTransactions, orders, outboxEvents, tableSessions } from "@/db/schema";
import { processOutboxBatch, type PublishedEvent } from "@/infrastructure/outbox/outbox";
import { publishToSubscribers, subscribe } from "@/infrastructure/realtime/realtime-hub";
import { getExpoView, getStationQueue } from "@/modules/kitchen/queries/kitchen-queries";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { listNotifications, markNotificationsRead } from "@/modules/notifications/notification-service";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";

import {
  createKitchenScenario,
  historyFor,
  notificationsForOrder,
  sendOrder,
  ticketItemsForOrder,
  ticketsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { createEmployeeFixture } from "../../fixtures/employee-fixtures";
import { clearOrderData, orderRow } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("fulfillment lifecycle", () => {
  let scenario: KitchenScenario;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function burgerOrder() {
    const sent = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
    ]);
    const [item] = await ticketItemsForOrder(database(), sent.order.id);

    return { ...sent, item: item! };
  }

  const step = (itemId: string, action: "start" | "ready" | "complete", expectedVersion: number) =>
    transitionTicketItem(database(), scenario.cook, itemId, action, { expectedVersion });

  it("runs NEW -> PREPARING -> READY -> COMPLETED with actor and time on each step", async () => {
    const { order, item } = await burgerOrder();
    const ledgerBefore = (await database().select().from(inventoryTransactions)).length;
    const started = await step(item.id, "start", item.version);
    const ready = await step(item.id, "ready", started.version);
    const done = await step(item.id, "complete", ready.version);

    expect([started.status, ready.status, done.status]).toEqual(["PREPARING", "READY", "COMPLETED"]);

    const [row] = await ticketItemsForOrder(database(), order.id);

    expect(row!.startedByUserId).toBe(scenario.cook.userId);
    expect(row!.readyByUserId).toBe(scenario.cook.userId);
    expect(row!.completedByUserId).toBe(scenario.cook.userId);
    expect(row!.startedAt!.getTime()).toBeLessThanOrEqual(row!.readyAt!.getTime());
    expect(row!.readyAt!.getTime()).toBeLessThanOrEqual(row!.completedAt!.getTime());
    expect((await historyFor(database(), [item.id])).map((entry) => entry.status)).toEqual([
      "NEW",
      "PREPARING",
      "READY",
      "COMPLETED",
    ]);

    // No inventory moves, and the commercial order is untouched and still OPEN.
    expect((await database().select().from(inventoryTransactions)).length).toBe(ledgerBefore);
    expect((await orderRow(database(), order.id)).status).toBe("OPEN");
  });

  it("refuses NEW -> READY, backward moves and anything after COMPLETED", async () => {
    const { item } = await burgerOrder();

    await expect(step(item.id, "ready", item.version)).rejects.toMatchObject({
      code: "FULFILLMENT_INVALID_TRANSITION",
    });

    const started = await step(item.id, "start", item.version);
    const ready = await step(item.id, "ready", started.version);

    await expect(step(item.id, "start", ready.version)).rejects.toMatchObject({
      code: "FULFILLMENT_INVALID_TRANSITION",
    });

    const done = await step(item.id, "complete", ready.version);

    await expect(step(item.id, "ready", done.version)).rejects.toMatchObject({
      code: "FULFILLMENT_ITEM_TERMINAL",
    });
  });

  it("a repeated tap is an idempotent success with no second history row", async () => {
    const { item } = await burgerOrder();
    const first = await step(item.id, "start", item.version);
    const again = await step(item.id, "start", item.version);

    expect(again).toMatchObject({ status: "PREPARING", alreadyApplied: true, version: first.version });
    expect(await historyFor(database(), [item.id])).toHaveLength(2);
  });

  it("a stale version for a real move is a conflict", async () => {
    const { item } = await burgerOrder();
    const started = await step(item.id, "start", item.version);

    await expect(step(item.id, "ready", started.version - 1)).rejects.toMatchObject({
      code: "CONCURRENCY_CONFLICT",
    });
  });

  it("two cooks starting the same item at once: one transition, one history row", async () => {
    const { item } = await burgerOrder();
    const other = { ...scenario.cook, userId: scenario.voidManager.userId, permissions: scenario.voidManager.permissions };
    const results = await Promise.allSettled([
      step(item.id, "start", item.version),
      transitionTicketItem(database(), other, item.id, "start", { expectedVersion: item.version }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const values = results.map((result) => (result as PromiseFulfilledResult<{ alreadyApplied: boolean }>).value);

    expect(values.filter((value) => !value.alreadyApplied)).toHaveLength(1);

    const history = await historyFor(database(), [item.id]);

    expect(history.map((entry) => entry.status)).toEqual(["NEW", "PREPARING"]);
  });

  it("derives ticket status from items, and a ready ticket notifies the server once", async () => {
    const { order } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
    ]);

    const items = await ticketItemsForOrder(database(), order.id);
    const [ticket] = await ticketsForOrder(database(), order.id);
    const queue = async () =>
      (await getStationQueue(database(), scenario.cook, { stationType: "KITCHEN" })).active.find(
        (entry) => entry.id === ticket!.id,
      );

    expect((await queue())!.status).toBe("NEW");

    const a = await step(items[0]!.id, "start", items[0]!.version);

    expect((await queue())!.status).toBe("PREPARING");

    const aReady = await step(items[0]!.id, "ready", a.version);

    // READY + NEW: not all ready and nothing preparing, so the approved precedence says NEW.
    expect((await queue())!.status).toBe("NEW");
    expect(await notificationsForOrder(database(), order.id)).toHaveLength(0);

    const b = await step(items[1]!.id, "start", items[1]!.version);

    await step(items[1]!.id, "ready", b.version);

    expect((await queue())!.status).toBe("READY");

    const sent = await notificationsForOrder(database(), order.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      notificationType: "FOOD_READY",
      // No server is assigned, so the user who sent the batch hears it.
      recipientUserId: scenario.serverActor.userId,
      kitchenTicketId: ticket!.id,
    });
    expect(sent[0]!.title).toContain(`#${order.orderNumber}`);

    // Completing an item afterwards sends nothing more.
    await step(items[0]!.id, "complete", aReady.version);
    expect(await notificationsForOrder(database(), order.id)).toHaveLength(1);

    const mine = await listNotifications(database(), scenario.serverActor);

    expect(mine.unreadCount).toBeGreaterThanOrEqual(1);
    expect((await listNotifications(database(), scenario.cook)).notifications).toHaveLength(0);
    expect(await markNotificationsRead(database(), scenario.cook, { ids: [sent[0]!.id] })).toEqual({ updated: 0 });
    expect(await markNotificationsRead(database(), scenario.serverActor, { ids: [sent[0]!.id] })).toEqual({
      updated: 1,
    });
  });

  it("the order's server, through their linked active user, is the recipient", async () => {
    const employee = await createEmployeeFixture(database(), scenario.owner, { firstName: "Riley" });

    await database()
      .update(employees)
      .set({ userId: scenario.kitchenViewer.userId })
      .where(eq(employees.id, employee.id));

    const { order, item } = await burgerOrder();

    await database().update(orders).set({ assignedServerEmployeeId: employee.id }).where(eq(orders.id, order.id));

    const started = await step(item.id, "start", item.version);

    await step(item.id, "ready", started.version);

    const [notification] = await notificationsForOrder(database(), order.id);

    expect(notification!.recipientUserId).toBe(scenario.kitchenViewer.userId);
  });

  it("bar work notifies BAR_ORDER_READY and never appears in the kitchen queue", async () => {
    const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }]);
    const [item] = await ticketItemsForOrder(database(), order.id);
    const kitchen = await getStationQueue(database(), scenario.voidManager, { stationType: "KITCHEN" });

    expect(kitchen.active.some((ticket) => ticket.orderId === order.id)).toBe(false);

    const bar = await getStationQueue(database(), scenario.bartender, { stationType: "BAR" });

    expect(bar.active.find((ticket) => ticket.orderId === order.id)!.items[0]!.actions).toEqual({
      start: true,
      ready: false,
      complete: false,
    });

    const started = await transitionTicketItem(database(), scenario.bartender, item!.id, "start", {
      expectedVersion: item!.version,
    });

    await transitionTicketItem(database(), scenario.bartender, item!.id, "ready", {
      expectedVersion: started.version,
    });

    const [notification] = await notificationsForOrder(database(), order.id);

    expect(notification!.notificationType).toBe("BAR_ORDER_READY");
  });

  it("completed work leaves the order OPEN and the table session still blocked", async () => {
    const { order, item } = await burgerOrder();
    const started = await step(item.id, "start", item.version);
    const ready = await step(item.id, "ready", started.version);

    await step(item.id, "complete", ready.version);

    const current = await orderRow(database(), order.id);
    const [session] = await database()
      .select()
      .from(tableSessions)
      .where(eq(tableSessions.id, current.tableSessionId!));

    expect(current.status).toBe("OPEN");
    await expect(
      completeTableSession(database(), scenario.owner, session!.id, { expectedVersion: session!.version }),
    ).rejects.toMatchObject({ code: "ORDERS_OPEN" });
  });

  it("takeout completes the normal lifecycle and the order stays OPEN", async () => {
    const { order } = await sendOrder(
      database(),
      scenario,
      [{ menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly }],
      { orderType: "TAKEOUT" },
    );
    const [item] = await ticketItemsForOrder(database(), order.id);
    const started = await step(item!.id, "start", item!.version);
    const ready = await step(item!.id, "ready", started.version);

    await step(item!.id, "complete", ready.version);

    const [row] = await database().select().from(orders).where(eq(orders.id, order.id));

    expect(row!.status).toBe("OPEN");
    expect(row!.tableSessionId).toBeNull();
  });

  it("queues are FIFO, filterable, and expose no price or cost", async () => {
    const first = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }]);
    const second = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }], {
      orderType: "TAKEOUT",
    });
    const queue = await getStationQueue(database(), scenario.cook, {
      stationType: "KITCHEN",
      stationId: scenario.stations.fry.id,
    });
    const ours = queue.active.filter((ticket) => [first.order.id, second.order.id].includes(ticket.orderId));

    expect(ours.map((ticket) => ticket.orderId)).toEqual([first.order.id, second.order.id]);
    expect(JSON.stringify(queue)).not.toMatch(/price|cost|lineTotal|subtotal/i);

    const takeoutOnly = await getStationQueue(database(), scenario.cook, {
      stationType: "KITCHEN",
      orderType: "TAKEOUT",
    });

    expect(takeoutOnly.active.every((ticket) => ticket.orderType === "TAKEOUT")).toBe(true);
    expect(ours[0]!.ageBand).toBe("normal");
  });

  it("EXPO is read-only and shows overall readiness across stations", async () => {
    const { order } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.fries.id },
      { menuItemId: scenario.cocktail.id },
    ]);
    const items = await ticketItemsForOrder(database(), order.id);
    const fries = items.find((item) => item.menuItemNameSnapshot === "Fries")!;
    const started = await step(fries.id, "start", fries.version);

    await step(fries.id, "ready", started.version);

    const expo = await getExpoView(database(), scenario.kitchenViewer);
    const entry = expo.orders.find((row) => row.orderId === order.id)!;

    expect(entry.items.find((row) => row.name === "Fries")!.status).toBe("READY");
    expect(entry.items.find((row) => row.name === "Margarita")!.status).toBe("NEW");
    expect(entry.status).toBe("NEW");
    expect(JSON.stringify(expo)).not.toMatch(/actions/);
  });

  it("the outbox processor publishes committed events once, in sequence, to matching subscribers", async () => {
    // Publish whatever earlier tests left, so this test sees only its own events.
    await processOutboxBatch(database(), () => {}, { limit: 10_000 });

    const { order, sent } = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }]);
    const received: string[] = [];
    const otherLocation: string[] = [];
    const unsubscribe = subscribe({
      organizationId: scenario.organizationId,
      locationId: scenario.locationA,
      userId: scenario.bartender.userId,
      send: (message) => received.push(message.type),
    });
    const unsubscribeB = subscribe({
      organizationId: scenario.organizationId,
      locationId: scenario.locationB,
      userId: scenario.bartender.userId,
      send: (message) => otherLocation.push(message.type),
    });

    try {
      const published: PublishedEvent[] = [];
      const count = await processOutboxBatch(database(), (event) => {
        published.push(event);
        publishToSubscribers(event);
      });

      expect(count).toBe(2);
      expect(published.map((event) => event.sequence)).toEqual(
        [...published.map((event) => event.sequence)].sort((a, b) => a - b),
      );
      expect(received.sort()).toEqual(["kitchen.ticket-created", "order.items-submitted"]);
      expect(otherLocation).toEqual([]);
      expect(await processOutboxBatch(database(), () => {})).toBe(0);

      const rows = await database()
        .select()
        .from(outboxEvents)
        .where(inArray(outboxEvents.aggregateId, [order.id, ...sent.ticketIds]));

      expect(rows.every((row) => row.publishedAt !== null)).toBe(true);
    } finally {
      unsubscribe();
      unsubscribeB();
    }
  });

  it("a publisher failure leaves the event unpublished with its attempt recorded", async () => {
    await processOutboxBatch(database(), () => {}, { limit: 10_000 });
    await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }]);

    const count = await processOutboxBatch(database(), () => {
      throw new TypeError("down");
    });
    const pending = await database().select().from(outboxEvents).where(isNull(outboxEvents.publishedAt));

    expect(count).toBe(0);
    expect(pending.length).toBe(2);
    expect(pending.every((row) => row.attempts === 1 && row.lastError === "TypeError")).toBe(true);
    // Backed off by one second (Phase 16), then published.
    expect(pending.every((row) => row.nextAttemptAt !== null && row.failedAt === null)).toBe(true);
    expect(await processOutboxBatch(database(), () => {})).toBe(0);
    expect(await processOutboxBatch(database(), () => {}, { now: new Date(Date.now() + 2000) })).toBe(2);
  });

  it("a recipient-only notification event reaches only that user", async () => {
    await processOutboxBatch(database(), () => {}, { limit: 10_000 });

    const { item } = await burgerOrder();
    const started = await step(item.id, "start", item.version);

    await step(item.id, "ready", started.version);

    const server: string[] = [];
    const cook: string[] = [];
    const offServer = subscribe({
      organizationId: scenario.organizationId,
      locationId: scenario.locationA,
      userId: scenario.serverActor.userId,
      send: (message) => server.push(message.type),
    });
    const offCook = subscribe({
      organizationId: scenario.organizationId,
      locationId: scenario.locationA,
      userId: scenario.cook.userId,
      send: (message) => cook.push(message.type),
    });

    try {
      await processOutboxBatch(database(), publishToSubscribers);
    } finally {
      offServer();
      offCook();
    }

    expect(server).toContain("notification.created");
    expect(cook).not.toContain("notification.created");
    expect(cook).toContain("kitchen.item-ready");
  });
});
