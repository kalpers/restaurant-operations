import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryTransactions,
  kitchenTickets,
  notifications,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderSendBatches,
  outboxEvents,
  restaurantTables,
  reservations,
  settlements,
  settlementTenders,
  tableSessions,
} from "@/db/schema";
import { listAuditEvents } from "@/modules/auditing/queries/audit-queries";
import { listNotifications } from "@/modules/notifications/notification-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { getDayTimeline } from "@/modules/scheduling/services/timeline-service";
import type { ReportArea, ReportResult } from "@/modules/reporting/types";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import { itemRows, ledgerFor, onHand, orderRow } from "../../fixtures/order-fixtures";
import {
  DAY,
  FRIDAY,
  localInstant,
  runRestaurantDay,
  startFakeClock,
  stopFakeClock,
  SUNDAY,
  type RestaurantDay,
} from "../../fixtures/restaurant-day";

const database = () => getDatabase();

function row(report: ReportResult, sectionKey: string, column: string, value: unknown) {
  const found = report.sections
    .find((section) => section.key === sectionKey)
    ?.rows.find((candidate) => candidate[column] === value);

  expect(found, `${sectionKey} row ${column}=${String(value)}`).toBeDefined();

  return found!;
}

describe("Phase 13: a full simulated restaurant day", () => {
  let day: RestaurantDay;

  const report = (area: ReportArea, from = DAY, to = DAY) =>
    runReport(database(), day.actors.reporter, area, { locationId: day.scenario.locationA, from, to });

  beforeAll(async () => {
    startFakeClock();

    try {
      day = await runRestaurantDay(database());
    } finally {
      // Assertions run on the real clock; the day's records carry their simulated times.
      stopFakeClock();
    }
  }, 120_000);

  afterAll(async () => {
    stopFakeClock();
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("front of house", () => {
    it("check-in is planning only; seating creates the session the order references", async () => {
      expect(day.occupancyAfterCheckIn).toEqual([]);

      const [reservation] = await database().select().from(reservations).where(eq(reservations.id, day.reservation.id));
      const garcia = await orderRow(database(), day.orders.garcia.id);

      expect(reservation!.status).toBe("COMPLETED");
      expect(garcia.tableSessionId).toBe(day.sessions.garcia);
      expect(garcia.assignedServerEmployeeId).toBe(day.employees.server);
    });

    it("closing the order leaves the session open; ending it makes the table DIRTY, then CLEAN", async () => {
      expect(day.garciaSessionAfterClose.status).toBe("ACTIVE");
      expect(day.tableAAfterSession.condition).toBe("DIRTY");

      const tables = await database()
        .select()
        .from(restaurantTables)
        .where(inArray(restaurantTables.id, [day.tables.a, day.tables.b]));
      const sessions = await database()
        .select()
        .from(tableSessions)
        .where(inArray(tableSessions.id, [day.sessions.garcia, day.sessions.walkIn]));

      expect(tables.map((table) => table.condition)).toEqual(["CLEAN", "CLEAN"]);
      expect(sessions.map((session) => session.status)).toEqual(["COMPLETED", "COMPLETED"]);
    });
  });

  describe("the canonical Bacon Cheeseburger SEND", () => {
    it("snapshots price, modifiers, recipe revision and kitchen instructions", async () => {
      const burger = (await itemRows(database(), day.orders.garcia.id)).find(
        (item) => item.menuItemNameSnapshot === "Bacon Cheeseburger",
      )!;
      const modifiers = await database()
        .select()
        .from(orderItemModifiers)
        .where(eq(orderItemModifiers.orderItemId, burger.id))
        .orderBy(asc(orderItemModifiers.sortOrder));

      expect(burger).toMatchObject({
        status: "SUBMITTED",
        basePriceSnapshot: "15.99",
        modifierTotalSnapshot: "1.50",
        unitPriceSnapshot: "17.49",
        lineTotalSnapshot: "17.49",
        recipeId: day.scenario.burger.recipe.id,
        recipeVersionId: day.scenario.burger.revision.id,
        kitchenInstructionsSnapshot: "Cook medium; No onion; Extra pickles; Swiss, not American",
        sendBatchId: day.orders.garcia.sends.burger.batchId,
      });
      expect(modifiers.map((modifier) => [modifier.modifierNameSnapshot, modifier.priceAdjustmentSnapshot])).toEqual([
        ["Medium", "0.00"],
        ["No Onion", "0.00"],
        ["Extra Pickles", "0.50"],
        ["Swiss instead of American", "1.00"],
      ]);
    });

    it("consumes exactly the resolved ingredients, once, with ledger and balance agreeing", async () => {
      const { stock } = day.scenario.burger;
      const burger = (await itemRows(database(), day.orders.garcia.id)).find(
        (item) => item.menuItemNameSnapshot === "Bacon Cheeseburger",
      )!;
      const consumption = await database()
        .select()
        .from(orderItemInventoryConsumption)
        .where(eq(orderItemInventoryConsumption.orderItemId, burger.id));
      const byItem = new Map(consumption.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));

      // 0.5 LB beef = 8 OZ_WEIGHT; Swiss replaces American; no onion; 3 + 2 pickles.
      expect(byItem).toEqual(
        new Map([
          [stock.beef.id, "8.0000"],
          [stock.bun.id, "1.0000"],
          [stock.swiss.id, "1.0000"],
          [stock.pickles.id, "5.0000"],
          [stock.bacon.id, "2.0000"],
        ]),
      );

      for (const entry of consumption) {
        const [ledger] = await database()
          .select()
          .from(inventoryTransactions)
          .where(eq(inventoryTransactions.id, entry.inventoryTransactionId));

        expect(ledger).toMatchObject({ transactionType: "CONSUME", baseQuantityDelta: `-${entry.baseQuantity}`, businessDate: DAY });
      }

      // Every ingredient's balance equals its last ledger row, the ledger being authoritative.
      for (const item of Object.values(stock)) {
        const ledger = await ledgerFor(database(), item.id);

        expect(await onHand(database(), item.id)).toBe(ledger.at(-1)!.quantityAfter);
      }

      // Opening 100 + 24 received - 1 (canonical) - 1 (late Medium-only burger).
      expect(await onHand(database(), stock.bun.id)).toBe("122.0000");
      expect(await onHand(database(), stock.american.id)).toBe("99.0000");
      expect(await onHand(database(), stock.onion.id)).toBe("99.0000");
      expect(await onHand(database(), stock.swiss.id)).toBe("99.0000");
    });

    it("routes each send to its station once and writes outbox events in the same commit", async () => {
      const tickets = await database()
        .select()
        .from(kitchenTickets)
        .where(eq(kitchenTickets.orderId, day.orders.garcia.id))
        .orderBy(asc(kitchenTickets.submittedAt));

      expect(tickets.map((ticket) => ticket.stationCodeSnapshot.slice(0, 3))).toEqual(["BAR", "FRY", "GRL"]);

      const events = await database()
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, day.orders.garcia.id));

      expect(events.filter((event) => event.eventType === "order.items-submitted")).toHaveLength(3);
      expect(events.filter((event) => event.eventType === "order.closed")).toHaveLength(1);
    });

    it("a replayed SEND key returns the first result and adds nothing", async () => {
      const count = async () => ({
        batches: (await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, day.orders.garcia.id))).length,
        tickets: (await database().select().from(kitchenTickets).where(eq(kitchenTickets.orderId, day.orders.garcia.id))).length,
        consumption: (await database().select().from(orderItemInventoryConsumption)).length,
        ledger: (await database().select().from(inventoryTransactions)).length,
        outbox: (await database().select().from(outboxEvents)).length,
      });
      const before = await count();
      const { burger } = day.orders.garcia.sends;
      const replay = await sendOrderItems(database(), day.actors.server, day.orders.garcia.id, {
        expectedVersion: burger.orderVersion - 1,
        idempotencyKey: burger.key,
      });

      expect(replay).toMatchObject({ replayed: true, batchId: burger.batchId, ticketIds: burger.ticketIds });
      expect(await count()).toEqual(before);
    });
  });

  describe("fulfillment and notifications", () => {
    it("the server is told once per ready ticket, by in-app notification", async () => {
      const inbox = await listNotifications(database(), day.actors.server, 50);
      const forOrder = (orderId: string) => inbox.notifications.filter((entry) => entry.orderId === orderId);

      expect(forOrder(day.orders.garcia.id).map((entry) => entry.type).sort()).toEqual([
        "BAR_ORDER_READY",
        "FOOD_READY",
        "FOOD_READY",
      ]);
      expect(forOrder(day.orders.late.id).map((entry) => entry.type)).toEqual(["FOOD_READY"]);
      expect(forOrder(day.orders.takeout.id).map((entry) => entry.type)).toEqual(["FOOD_READY"]);

      const unread = await database().select().from(notifications).where(eq(notifications.recipientUserId, day.actors.server.userId));

      // Five ready notices; since Phase 20 the published schedule is announced too.
      expect(unread.filter((row) => row.notificationType.endsWith("READY"))).toHaveLength(5);
      expect(unread.filter((row) => row.notificationType === "SCHEDULE_PUBLISHED")).toHaveLength(1);
    });
  });

  describe("settlement and business date", () => {
    it("closes each order through a settlement that reconciles exactly", async () => {
      const ids = [day.orders.garcia.id, day.orders.takeout.id, day.orders.late.id];
      const closed = await Promise.all(ids.map((id) => orderRow(database(), id)));
      const rows = await database().select().from(settlements).where(inArray(settlements.orderId, ids));

      expect(closed.map((order) => [order.status, order.subtotal])).toEqual([
        ["CLOSED", "32.99"],
        ["CLOSED", "4.50"],
        ["CLOSED", "15.99"],
      ]);
      expect(rows.every((settlement) => settlement.status === "COMPLETED")).toBe(true);
      expect(day.orders.garcia.closed).toMatchObject({ tenderedAmount: "32.99", tipAmount: "5.00", changeDue: "0.00" });
      expect(day.orders.late.closed).toMatchObject({ tenderedAmount: "15.99", changeDue: "4.01" });
    });

    it("keeps the 00:30 check on Saturday's business date, from one BusinessDateService", async () => {
      const late = await orderRow(database(), day.orders.late.id);
      const [settlement] = await database().select().from(settlements).where(eq(settlements.orderId, late.id));
      const [tenderRow] = await database()
        .select()
        .from(settlementTenders)
        .where(eq(settlementTenders.settlementId, settlement!.id));

      expect(late.closedAt!.toISOString()).toBe(localInstant(SUNDAY, "00:30").toISOString());
      expect(late.businessDate).toBe(DAY);
      expect(settlement!.completedBusinessDate).toBe(DAY);
      expect(tenderRow!.businessDate).toBe(DAY);
    });
  });

  describe("reports reconcile with the day's operations", () => {
    it("sales equal the closed orders, and tenders equal sales", async () => {
      const sales = await report("sales");
      const settlementsReport = await report("settlements");

      expect(row(sales, "summary", "orderType", "All")).toMatchObject({
        closedOrders: 3,
        covers: 6,
        grossSales: "53.48",
        netSales: "53.48",
        openChecks: 0,
        voidedItems: 0,
      });
      expect(row(settlementsReport, "tenders", "tenderType", "All")).toMatchObject({
        tenders: 4,
        amount: "53.48",
        tips: "5.00",
        received: "40.00",
        change: "4.01",
      });
      // Nothing from the day leaks onto Sunday's business date.
      expect(row(await report("sales", SUNDAY, SUNDAY), "summary", "orderType", "All")).toMatchObject({ closedOrders: 0 });
    });

    it("menu performance shows the snapshot prices and modifiers", async () => {
      const menu = await report("menu");

      expect(row(menu, "items", "name", "Bacon Cheeseburger")).toMatchObject({ quantity: 2, grossSales: "33.48" });
      expect(row(menu, "items", "name", "Fries")).toMatchObject({ quantity: 2, grossSales: "9.00" });
      expect(row(menu, "items", "name", "Margarita")).toMatchObject({ quantity: 1, grossSales: "11.00" });
      expect(row(menu, "modifiers", "modifier", "Swiss instead of American")).toMatchObject({ quantity: 1, revenue: "1.00" });
    });

    it("inventory usage equals the SEND ledger rows, with the receipt", async () => {
      const inventory = await report("inventory");

      expect(row(inventory, "usage", "name", "Brioche bun")).toMatchObject({
        received: "24.0000",
        theoretical: "2.0000",
        closing: "122.0000",
      });
      expect(row(inventory, "usage", "name", "Ground beef")).toMatchObject({ theoretical: "16.0000" });
      expect(row(inventory, "usage", "name", "Pickle chip")).toMatchObject({ theoretical: "8.0000" });
    });

    it("fulfillment counts every station item the day produced", async () => {
      const fulfillment = await report("fulfillment");

      expect(row(fulfillment, "stations", "station", "All stations")).toMatchObject({ items: 5, completed: 5, cancelled: 0 });
      expect(row(fulfillment, "stations", "station", "Grill")).toMatchObject({ items: 2, completed: 2 });
    });

    it("labor is the published schedule costed at each Employee + Position wage", async () => {
      const labor = await report("labor");

      // 10 h × 12.00 + 7 h × 14.00 + 8 h × 18.00.
      expect(labor.sections.find((section) => section.key === "summary")!.rows[0]).toMatchObject({
        shifts: 3,
        hours: "25.0000",
        cost: "362.00",
      });
    });

    it("seating counts both sessions and their covers", async () => {
      const seating = await report("seating");

      expect(row(seating, "sessions", "area", "All areas")).toMatchObject({ sessions: 2, covers: 6, tablesUsed: 2 });
    });
  });

  describe("audit reflects the day", () => {
    it("records each audited action once, and the replay none", async () => {
      const page = await listAuditEvents(database(), day.actors.auditor, {
        locationId: day.scenario.locationA,
        from: FRIDAY,
        to: DAY,
      });
      const count = (action: string) => page.events.filter((event) => event.action === action).length;

      expect(count("scheduling.period-published")).toBe(1);
      expect(count("hr.compensation-changed")).toBe(3);
      expect(count("inventory.po-received")).toBe(1);
      // Garcia's three batches, the takeout and the late burger; the replay wrote nothing.
      expect(count("orders.items-sent")).toBe(5);
      expect(count("settlements.opened")).toBe(3);
      expect(count("settlements.tender-recorded")).toBe(4);
      expect(count("settlements.completed")).toBe(3);
      // The 00:30 completion falls on Saturday's business date, so a FRIDAY..DAY range holds it.
      expect(
        page.events.some(
          (event) => event.action === "settlements.completed" && event.occurredAt === localInstant(SUNDAY, "00:30").toISOString(),
        ),
      ).toBe(true);
    });

    it("holds no wage amount, card detail or personal value", async () => {
      const page = await listAuditEvents(database(), day.actors.auditor, {
        locationId: day.scenario.locationA,
        from: FRIDAY,
        to: DAY,
      });
      const text = JSON.stringify(page.events);

      expect(text).not.toMatch(/12\.00|14\.00|18\.00/);
      expect(text).not.toContain("4242");
      expect(text).not.toContain("Square");
      expect(text).not.toContain("jane@work.example.test");
    });
  });

  describe("schedule timeline (Phase 14)", () => {
    it("shows the day's published shifts, with the server's overnight shift ending next day", async () => {
      const data = await getDayTimeline(database(), day.actors.manager, { date: DAY, includeDrafts: true });
      const bars = data.bars.filter((bar) => bar.kind === "ASSIGNMENT");
      const server = bars.find((bar) => bar.employeeId === day.employees.server)!;

      expect(bars.map((bar) => bar.employeeId).sort()).toEqual(
        [day.employees.server, day.employees.host, day.employees.cook].sort(),
      );
      expect(bars.every((bar) => bar.periodId === day.period.id && bar.periodStatus === "PUBLISHED")).toBe(true);
      expect(server).toMatchObject({ endsNextDay: true, durationMinutes: 600 });
      expect(data.bars.some((bar) => bar.kind === "OPEN")).toBe(false);
      expect(JSON.stringify(data)).not.toMatch(/12\.00|14\.00|18\.00/);
    });
  });
});
