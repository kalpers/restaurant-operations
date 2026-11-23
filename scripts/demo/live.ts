import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";

import type { Database } from "../../src/db";
import { PIZZA_HAPPY_HOUR, LOT_TRACKED_INGREDIENTS } from "../../src/db/demo/pizza/menu";
import { PIZZA_BOOKING_HOURS } from "../../src/db/demo/pizza/restaurant";
import {
  guestParties,
  inventoryItemLocations,
  inventoryItems,
  inventoryLots,
  menuItemOutages,
  menuItems,
  modifierGroups,
  modifiers,
  positions,
  pricePeriods,
  reservations,
  schedulePeriods,
  shiftAssignments,
  shiftSwapRequests,
  shifts,
  tableSessions,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { enableLotTracking } from "../../src/modules/inventory/services/lot-service";
import { recordAdjustment } from "../../src/modules/inventory/services/stock-operations";
import { createPricePeriod } from "../../src/modules/menu/services/price-period-service";
import { getAuto86Setting, markItemOut, setAuto86FromStock } from "../../src/modules/menu/services/outage-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createOnlineReservation, getOnlineBookingSettings, replaceBookingPeriods, saveOnlineBookingSettings } from "../../src/modules/reservations/services/online-booking-service";
import { createReservation } from "../../src/modules/reservations/services/reservation-service";
import { addToWaitlist } from "../../src/modules/reservations/services/waitlist-service";
import { getFloorStatus } from "../../src/modules/restaurant/services/floor-service";
import { openSwapForEmployee, recordSwapAcceptance } from "../../src/modules/scheduling/services/swap-service";
import { addDays, localToInstant } from "../../src/shared/time/zoned-time";
import { completeTableSession } from "../../src/workflows/end-table-session/end-table-session";
import { seatParty } from "../../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { between, codeOf, need, pickFrom, seededRandom } from "./helpers";
import { receiveShortfalls } from "./history";

const KEY = "demo.pizza";
const FIRST_NAMES = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Rowan", "Sage", "Emerson", "Hayden", "Parker", "Reese"];
const LAST_NAMES = ["Nguyen", "Okafor", "Lindqvist", "Moreau", "Haddad", "Kowalski", "Tanaka", "Silva", "Brennan", "Duarte"];
/** Kept low after the morning delivery, so the 86 board shows it running low. */
const LEFT_LOW = "CALAMARI";

type Tracker = { done: Set<string>; record: (key: string) => Promise<void> };

/** The weekday happy hour, made with the clock before the history so past checks show it. */
export async function seedHappyHour(database: Database, owner: Actor): Promise<number> {
  const [existing] = await database.select({ id: pricePeriods.id }).from(pricePeriods).where(and(eq(pricePeriods.locationId, owner.locationId), eq(pricePeriods.name, PIZZA_HAPPY_HOUR.name)));

  if (existing) {
    return 0;
  }

  const items = await database
    .select({ id: menuItems.id, code: menuItems.code })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, Object.keys(PIZZA_HAPPY_HOUR.prices))));

  await createPricePeriod(database, owner, {
    name: PIZZA_HAPPY_HOUR.name,
    daysOfWeek: PIZZA_HAPPY_HOUR.daysOfWeek,
    startTime: PIZZA_HAPPY_HOUR.startTime,
    endTime: PIZZA_HAPPY_HOUR.endTime,
    orderTypes: PIZZA_HAPPY_HOUR.orderTypes,
    firstDate: null,
    lastDate: null,
    items: items.map((item) => ({ menuItemId: item.id, price: PIZZA_HAPPY_HOUR.prices[item.code]! })),
  });

  return 1;
}

export type LiveSummary = { deliveries: number; lots: number; reservations: number; waitlist: number; openTables: number; dirtyTables: number; outages: number; swap: string };

/**
 * Today, with the real clock: this morning's delivery back up to par (one item left low), lot
 * tracking with dated lots on the mozzarella, the 86 board (auto-86 on, tiramisu out for the
 * night), reservations for the coming week and online booking, tonight's waitlist, three tables
 * with food and drinks on the kitchen and bar screens, a table waiting to be cleaned, and a
 * shift swap waiting for a manager.
 */
export async function seedPizzaLive(database: Database, owner: Actor, input: Tracker & { today: string; timeZone: string; locationCode: string }): Promise<LiveSummary> {
  const summary: LiveSummary = { deliveries: 0, lots: 0, reservations: 0, waitlist: 0, openTables: 0, dirtyTables: 0, outages: 0, swap: "already there" };
  const { done, record, today } = input;

  // --------------------------------------------------- this morning's delivery
  if (!done.has(`${KEY}.delivery.${today}`)) {
    const par = await database
      .select({ id: inventoryItems.id, code: inventoryItems.code, par: inventoryItemLocations.parLevel })
      .from(inventoryItemLocations)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryItemLocations.inventoryItemId))
      .where(and(eq(inventoryItemLocations.locationId, owner.locationId), isNotNull(inventoryItemLocations.parLevel), ne(inventoryItems.code, LEFT_LOW)));
    const totals = new Map(par.map((row) => [row.id, row.par!]));

    summary.deliveries = await receiveShortfalls(database, owner, totals, "1", new Date(), "Morning delivery (demo).");
    await record(`${KEY}.delivery.${today}`);
  }

  // ---------------------------------------------------------------- lots
  const lotItems = await database
    .select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId, lotTracked: inventoryItems.lotTracked, version: inventoryItems.version })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, owner.organizationId), inArray(inventoryItems.code, [...LOT_TRACKED_INGREDIENTS])));

  for (const item of lotItems) {
    if (!item.lotTracked) {
      await enableLotTracking(database, owner, item.id, item.version);
    }

    const [dated] = await database.select({ id: inventoryLots.id }).from(inventoryLots).where(and(eq(inventoryLots.inventoryItemId, item.id), isNotNull(inventoryLots.expiresOn))).limit(1);

    if (!dated) {
      // Two cases from this morning's truck: one to use first (expiring in two days), one later.
      for (const days of [2, 12]) {
        await recordAdjustment(database, owner, {
          inventoryItemId: item.id,
          quantity: "320",
          unitOfMeasureId: item.baseUnitId,
          direction: "INCREASE",
          reasonCode: "FOUND_STOCK",
          expiresOn: addDays(today, days),
          notes: "Demo lot from the morning delivery",
        });
        summary.lots += 1;
      }
    }
  }

  // ----------------------------------------------------------- the 86 board
  const auto86 = await getAuto86Setting(database, owner);

  if (!auto86.enabled) {
    await setAuto86FromStock(database, owner, { enabled: true, runningLowPortions: 10, expectedVersion: auto86.version });
  }

  if (!done.has(`${KEY}.outage.${today}`)) {
    const [tiramisu] = await database.select({ id: menuItems.id }).from(menuItems).where(and(eq(menuItems.organizationId, owner.organizationId), eq(menuItems.code, "TIRAMISU")));
    const [already] = tiramisu
      ? await database.select({ id: menuItemOutages.id }).from(menuItemOutages).where(and(eq(menuItemOutages.menuItemId, tiramisu.id), eq(menuItemOutages.locationId, owner.locationId))).limit(1)
      : [];

    if (tiramisu && !already && (await codeOf(markItemOut(database, owner, { menuItemId: tiramisu.id, reason: "Sold out until Thursday's bake", untilClose: true }))) === null) {
      summary.outages += 1;
    }

    await record(`${KEY}.outage.${today}`);
  }

  // ------------------------------------------------- reservations and waitlist
  summary.reservations += await upcomingReservations(database, owner, input);
  summary.waitlist += await tonightsWaitlist(database, owner, input);

  // ------------------------------------------------- tables in service now
  if (!done.has(`${KEY}.live.${today}`)) {
    const opened = await liveTables(database, owner);

    summary.openTables = opened.open;
    summary.dirtyTables = opened.dirty;
    await record(`${KEY}.live.${today}`);
  }

  summary.swap = await pendingSwap(database, owner);

  return summary;
}

async function upcomingReservations(database: Database, owner: Actor, input: Tracker & { today: string; timeZone: string; locationCode: string }): Promise<number> {
  const key = `${KEY}.upcoming.${input.today}`;

  if (input.done.has(key)) {
    return 0;
  }

  const settings = await getOnlineBookingSettings(database, owner);

  if (!settings.enabled) {
    await saveOnlineBookingSettings(database, owner, {
      enabled: true,
      requiresApproval: false,
      maxPartySize: 8,
      minLeadMinutes: 120,
      maxDaysAhead: 30,
      slotIntervalMinutes: 15,
      maxCoversPerSlot: 24,
      reminderHoursBefore: 24,
      publicNote: "Large parties (9 or more), please call us.",
      expectedVersion: settings.version,
    });
    await replaceBookingPeriods(database, owner, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAt: PIZZA_BOOKING_HOURS.startsAt, endsAt: PIZZA_BOOKING_HOURS.endsAt })));
  }

  let created = 0;

  for (let day = 1; day <= 7; day += 1) {
    const date = addDays(input.today, day);
    const random = seededRandom(`demo-pizza-upcoming-${date}`);
    const name = () => `${pickFrom(random, FIRST_NAMES)} ${pickFrom(random, LAST_NAMES)}`;

    for (const time of ["17:00", "17:45", "18:30", "19:15", "20:00"].slice(0, between(random, 2, 5))) {
      const guestName = name();
      const partySize = between(random, 2, 8);
      const reservationAt = localToInstant(date, time, input.timeZone)!;
      const [exists] = await database
        .select({ id: reservations.id })
        .from(reservations)
        .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
        .where(and(eq(reservations.locationId, owner.locationId), eq(reservations.reservationAt, reservationAt), eq(guestParties.guestName, guestName)));

      if (exists) {
        continue;
      }

      await createReservation(database, owner, {
        guestName,
        partySize,
        phone: `(555) 1${String(between(random, 0, 99)).padStart(2, "0")}-${String(between(random, 1000, 9999))}`,
        localDate: date,
        localTime: time,
        source: "PHONE",
        guestProfileId: null,
        specialRequests: random() < 0.2 ? pickFrom(random, ["Birthday: a candle in the cannoli", "High chair, please", "Booth if possible"]) : null,
      });
      created += 1;
    }

    const guest = name();

    const online = await codeOf(
      createOnlineReservation(
        database,
        input.locationCode,
        {
          localDate: date,
          localTime: "18:00",
          partySize: between(random, 2, 4),
          guestName: guest,
          phone: `(555) 2${String(day).padStart(2, "0")}-${String(between(random, 1000, 9999))}`,
          email: `${guest.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
          specialRequests: null,
          messageConsent: { sms: true, email: random() < 0.5 },
          allergies: [],
          website: "",
          idempotencyKey: `demo-pizza-online-${date}`,
        },
        { clientIp: null },
      ),
    );

    if (online === null) {
      created += 1;
    }
  }

  await input.record(key);

  return created;
}

async function tonightsWaitlist(database: Database, owner: Actor, input: Tracker & { today: string }): Promise<number> {
  const key = `${KEY}.waitlist.${input.today}`;

  if (input.done.has(key)) {
    return 0;
  }

  const parties = [
    { guestName: "Dana Whitfield", partySize: 2, quotedWaitMinutes: 15 },
    { guestName: "The Okafor family", partySize: 5, quotedWaitMinutes: 30 },
    { guestName: "Priya Raman", partySize: 3, quotedWaitMinutes: 25 },
  ];

  for (const party of parties) {
    await addToWaitlist(database, owner, { ...party, phone: null });
  }

  await input.record(key);

  return parties.length;
}

/** Three tables mid-meal (pizzas in the oven, starters held, a bar tab) and one to clean. */
async function liveTables(database: Database, owner: Actor): Promise<{ open: number; dirty: number }> {
  const floor = await getFloorStatus(database, owner);
  const free = (type: string, capacity: number) => floor.find((table) => table.area.type === type && table.availability === "AVAILABLE" && table.capacity >= capacity && !taken.has(table.id));
  const taken = new Set<string>();
  const ids = new Map(
    (await database.select({ id: menuItems.id, code: menuItems.code }).from(menuItems).where(eq(menuItems.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );
  const pick = async (group: string, modifier: string) => {
    const [row] = await database
      .select({ modifierGroupId: modifierGroups.id, modifierId: modifiers.id })
      .from(modifierGroups)
      .innerJoin(modifiers, eq(modifiers.organizationId, modifierGroups.organizationId))
      .where(and(eq(modifierGroups.organizationId, owner.organizationId), eq(modifierGroups.code, group), eq(modifiers.code, modifier)));

    return row!;
  };
  const tables = [
    {
      type: "DINING",
      size: 4,
      orderType: "DINE_IN" as const,
      fire: "ALL" as const,
      lines: [
        { code: "PEPPERONI_PIZZA", selections: [await pick("PIZZA_SIZE", "SIZE_16")], course: 1 },
        { code: "SUPREME_PIZZA", selections: [await pick("PIZZA_SIZE", "SIZE_14")], course: 1 },
        { code: "DRAFT_LAGER", selections: [], course: 1 },
        { code: "FOUNTAIN_SODA", selections: [], course: 1 },
      ],
    },
    {
      type: "DINING",
      size: 2,
      orderType: "DINE_IN" as const,
      fire: "FIRST_COURSE" as const,
      lines: [
        { code: "FRIED_CALAMARI", selections: [], course: 1 },
        { code: "CHIANTI_GLASS", selections: [], course: 1 },
        { code: "MARGHERITA_PIZZA", selections: [await pick("PIZZA_SIZE", "SIZE_14")], course: 2 },
        { code: "CHICKEN_PARM_SUB", selections: [await pick("SANDWICH_SIDE", "SIDE_FRIES")], course: 2 },
      ],
    },
    {
      type: "BAR",
      size: 2,
      orderType: "BAR" as const,
      fire: "ALL" as const,
      lines: [
        { code: "OLD_FASHIONED", selections: [], course: 1 },
        { code: "HOUSE_IPA", selections: [], course: 1 },
        { code: "GARLIC_KNOTS", selections: [], course: 1 },
      ],
    },
  ];
  let open = 0;

  for (const plan of tables) {
    const table = free(plan.type, plan.size);

    if (!table) {
      continue;
    }

    taken.add(table.id);

    const session = await seatParty(database, owner, { tableIds: [table.id], partySize: plan.size, serverEmployeeId: null });
    const order = await createOrder(database, owner, { orderType: plan.orderType, tableSessionId: session.id });
    let version = order.version;

    for (const [index, line] of plan.lines.entries()) {
      version = (
        await addDraftItem(database, owner, order.id, {
          expectedVersion: version,
          menuItemId: need(ids, line.code, "menu item"),
          quantity: 1,
          selections: line.selections,
          specialInstructions: null,
          courseNumber: line.course,
          seatNumber: plan.orderType === "DINE_IN" ? (index % plan.size) + 1 : null,
        })
      ).orderVersion;
    }

    if ((await codeOf(sendOrderItems(database, owner, order.id, { expectedVersion: version, idempotencyKey: randomUUID(), fire: plan.fire }))) === null) {
      open += 1;
    }
  }

  // A two-top that just left: the table waits for the busser.
  let dirty = 0;
  const two = free("DINING", 2);

  if (two) {
    const session = await seatParty(database, owner, { tableIds: [two.id], partySize: 2, serverEmployeeId: null });
    const [row] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, session.id));

    if ((await codeOf(completeTableSession(database, owner, session.id, { expectedVersion: row!.version }))) === null) {
      dirty += 1;
    }
  }

  return { open, dirty };
}

/** A server asks to give a shift later this week to another server; it waits for a manager. */
async function pendingSwap(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: shiftSwapRequests.id })
    .from(shiftSwapRequests)
    .innerJoin(shiftAssignments, eq(shiftAssignments.id, shiftSwapRequests.shiftAssignmentId))
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(eq(shifts.locationId, owner.locationId))
    .limit(1);

  if (existing) {
    return "already there";
  }

  const [server] = await database.select({ id: positions.id }).from(positions).where(and(eq(positions.organizationId, owner.organizationId), eq(positions.code, "SERVER")));
  const candidates = await database
    .select({ assignmentId: shiftAssignments.id, employeeId: shiftAssignments.employeeId, shiftId: shifts.id })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shifts.locationId, owner.locationId),
        eq(shifts.positionId, server!.id),
        eq(schedulePeriods.status, "PUBLISHED"),
        eq(shiftAssignments.status, "ACTIVE"),
        gt(shifts.startAt, new Date(Date.now() + 24 * 3_600_000)),
      ),
    )
    .orderBy(asc(shifts.startAt))
    .limit(12);

  for (const candidate of candidates) {
    const others = candidates.filter((row) => row.employeeId !== candidate.employeeId && row.shiftId !== candidate.shiftId);

    for (const target of others) {
      const swap = await openSwapForEmployee(database, owner, { assignmentId: candidate.assignmentId, targetEmployeeId: target.employeeId, reason: "Family dinner that night" }).catch(() => null);

      if (!swap) {
        continue;
      }

      const [row] = await database.select({ version: shiftSwapRequests.version }).from(shiftSwapRequests).where(eq(shiftSwapRequests.id, swap.id));
      const accepted = await codeOf(recordSwapAcceptance(database, owner, swap.id, { expectedVersion: row!.version }));

      return accepted === null ? "accepted by the other server, waiting for a manager" : "asked, waiting for the other server";
    }
  }

  return "skipped (no published server shift later this week)";
}
