import { and, eq } from "drizzle-orm";
import { vi } from "vitest";

import type { Database } from "@/db";
import {
  employees,
  kitchenTicketItems,
  orders,
  reservations,
  restaurantTables,
  schedulePeriods,
  settlements,
  tableSessions,
  waitlistEntries,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { changeCompensation } from "@/modules/employees/services/compensation-service";
import { linkUser } from "@/modules/employees/services/user-link-service";
import {
  addPurchaseOrderLine,
  createPurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "@/modules/inventory/services/receiving-service";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import {
  checkInReservation,
  confirmReservation,
  createReservation,
} from "@/modules/reservations/services/reservation-service";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";
import { cleanTable } from "@/modules/restaurant/services/table-service";
import {
  assignEmployee,
  createPeriod,
  createShift,
  publishPeriod,
} from "@/modules/scheduling/services/schedule-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { localToInstant } from "@/shared/time/zoned-time";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";
import { seatReservationParty, seatWaitlistParty } from "@/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems, type SendResult } from "@/workflows/submit-order/submit-order";

import { actorWith } from "./employee-fixtures";
import { supplierWith } from "./inventory-fixtures";
import { createKitchenScenario, type KitchenScenario } from "./kitchen-fixtures";
import { newKey } from "./order-fixtures";
import { RESERVATION_HOST_PERMISSIONS } from "./reservation-fixtures";
import { HOST_PERMISSIONS, tableFixture } from "./restaurant-fixtures";
import { createSchedulableEmployee } from "./scheduling-fixtures";
import { SERVER_SETTLEMENT_PERMISSIONS, tender } from "./settlement-fixtures";

/**
 * Phase 13's simulated restaurant day (README section 38), run through the application's
 * services and workflows only: nothing here writes an operational row directly. The
 * fixture organization, location, areas, positions and role-holding actors are scaffolding
 * (no service creates organizations); the menu, recipe and opening stock come from the
 * service-based kitchen scenario, configured in advance.
 *
 * The day runs on a faked `Date` clock, because Scheduling refuses to schedule into the
 * past. Every timestamp the services write comes from `new Date()`, so the clock drives the
 * whole chain: the manager publishes on Friday morning, the party is seated Saturday evening,
 * and the last check settles at 00:30 on Sunday, before the 4:00 AM cutoff, so it still
 * belongs to Saturday's business date.
 */

export const DAY_TIME_ZONE = "America/Detroit";
/** The simulated Saturday. Its business date runs to 04:00 on Sunday. */
export const DAY = "2030-10-05";
export const FRIDAY = "2030-10-04";
export const SUNDAY = "2030-10-06";

/** Hourly wages per scheduled Employee + Position. */
export const WAGES = { server: "12.00", host: "14.00", cook: "18.00" } as const;

export const REPORTER_PERMISSIONS: readonly PermissionCode[] = [
  "reports.view",
  "reports.sales",
  "reports.orders",
  "reports.inventory",
  "reports.fulfillment",
  "reports.labor",
  "reports.settlements",
  "reports.seating",
  "reports.export",
  "inventory.cost.view",
  "hr.compensation.view",
];

const MANAGER_PERMISSIONS: readonly PermissionCode[] = [
  "schedule.view",
  "schedule.edit",
  "schedule.publish",
  "inventory.view",
  "inventory.receive",
  "inventory.cost.view",
  "purchasing.view",
  "purchasing.manage",
  "purchasing.submit",
  "suppliers.manage",
];

/** The instant of a local wall-clock time at the fixture location. */
export function localInstant(localDate: string, localTime: string): Date {
  const instant = localToInstant(localDate, localTime, DAY_TIME_ZONE);

  if (!instant) {
    throw new Error(`${localDate} ${localTime} does not exist in ${DAY_TIME_ZONE}`);
  }

  return instant;
}

/** Sets the faked clock to a local wall-clock time. Only while `startFakeClock()` is on. */
export function at(localDate: string, localTime: string): Date {
  const instant = localInstant(localDate, localTime);

  vi.setSystemTime(instant);

  return instant;
}

/** Fakes `Date` only; timers stay real so database connections behave normally. */
export function startFakeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
}

export function stopFakeClock(): void {
  vi.useRealTimers();
}

async function versionOf(
  database: Database,
  table: typeof schedulePeriods | typeof employees | typeof tableSessions | typeof restaurantTables | typeof orders,
  id: string,
): Promise<number> {
  const [row] = await database.select({ version: table.version }).from(table).where(eq(table.id, id));

  return row!.version;
}

async function ticketItem(database: Database, orderId: string, name: string) {
  const [row] = await database
    .select()
    .from(kitchenTicketItems)
    .where(and(eq(kitchenTicketItems.orderId, orderId), eq(kitchenTicketItems.menuItemNameSnapshot, name)));

  return row!;
}

export type DaySend = SendResult & { key: string };

export type RestaurantDay = Awaited<ReturnType<typeof runRestaurantDay>>;

/**
 * Builds the scenario, then runs the day. Call `startFakeClock()` first and
 * `stopFakeClock()` when finished.
 */
export async function runRestaurantDay(database: Database) {
  const scenario: KitchenScenario = await createKitchenScenario(database);
  const { owner, burger } = scenario;

  const manager = await actorWith(database, scenario, MANAGER_PERMISSIONS);
  const host = await actorWith(database, scenario, [...HOST_PERMISSIONS, ...RESERVATION_HOST_PERMISSIONS]);
  const server = await actorWith(database, scenario, SERVER_SETTLEMENT_PERMISSIONS);
  const reporter = await actorWith(database, scenario, REPORTER_PERMISSIONS);
  const auditor = await actorWith(database, scenario, ["audit.view"]);

  const serverEmployee = await createSchedulableEmployee(database, scenario.base, { positionId: scenario.server, firstName: "Sam" });
  const hostEmployee = await createSchedulableEmployee(database, scenario.base, {
    positionId: scenario.hostPosition,
    firstName: "Hana",
  });
  const cookEmployee = await createSchedulableEmployee(database, scenario.base, { positionId: scenario.base.cook, firstName: "Cole" });
  const tableA = await tableFixture(database, scenario.base, { tableNumber: "DAY-1", capacity: 4 });
  const tableB = await tableFixture(database, scenario.base, { tableNumber: "DAY-2", capacity: 4 });

  // ---- Friday: wages, the server's login, the published schedule, a reservation, a PO.
  at(FRIDAY, "09:00");

  const wage = (employeeId: string, positionId: string, hourlyRate: string) =>
    changeCompensation(database, owner, {
      employeeId,
      positionId,
      compensationType: "HOURLY",
      hourlyRate,
      annualSalary: null,
      effectiveFrom: "2024-01-15",
      changeReason: null,
    });

  await wage(serverEmployee, scenario.server, WAGES.server);
  await wage(hostEmployee, scenario.hostPosition, WAGES.host);
  await wage(cookEmployee, scenario.base.cook, WAGES.cook);
  // The ready notification goes to the session's server through this link.
  await linkUser(database, owner, {
    employeeId: serverEmployee,
    userId: server.userId,
    expectedVersion: await versionOf(database, employees, serverEmployee),
  });

  at(FRIDAY, "10:00");

  const period = await createPeriod(database, manager, { name: "Saturday", startDate: DAY, endDate: DAY });
  const shiftFor = async (positionId: string, startTime: string, endTime: string, employeeId: string) => {
    const shift = await createShift(database, manager, period.id, {
      positionId,
      restaurantAreaId: null,
      shiftDate: DAY,
      startTime,
      endTime,
      requiredEmployeeCount: 1,
      courseOrStationNote: null,
      notes: null,
      priority: 0,
      expectedPeriodVersion: await versionOf(database, schedulePeriods, period.id),
    });

    await assignEmployee(database, manager, shift.id, {
      employeeId,
      notes: null,
      expectedPeriodVersion: await versionOf(database, schedulePeriods, period.id),
    });

    return shift;
  };

  // Server 16:00-02:00 (10 h, overnight), host 16:00-23:00 (7 h), cook 15:00-23:00 (8 h).
  await shiftFor(scenario.server, "16:00", "02:00", serverEmployee);
  await shiftFor(scenario.hostPosition, "16:00", "23:00", hostEmployee);
  await shiftFor(scenario.base.cook, "15:00", "23:00", cookEmployee);
  await publishPeriod(database, manager, period.id, {
    expectedVersion: await versionOf(database, schedulePeriods, period.id),
  });

  at(FRIDAY, "11:00");

  const reservation = await createReservation(database, host, {
    guestName: "Garcia",
    partySize: 4,
    source: "PHONE",
    expectedDurationMinutes: 90,
    localDate: DAY,
    localTime: "19:00",
    status: "PENDING",
  });
  const confirmed = await confirmReservation(database, host, reservation.id, { expectedVersion: reservation.version });

  const { supplier, supplierItems } = await supplierWith(database, manager, [
    { inventoryItemId: burger.stock.bun.id, purchaseUnitId: scenario.units.each, lastUnitCost: "0.2000" },
  ]);
  const purchaseOrder = await createPurchaseOrder(database, manager, { supplierId: supplier.id, expectedAt: null, notes: null });
  const poLine = await addPurchaseOrderLine(database, manager, purchaseOrder.id, {
    supplierItemId: supplierItems[0]!.id,
    orderedQuantity: "24",
    unitPrice: "0.2000",
    expectedVersion: purchaseOrder.version,
  });

  await submitPurchaseOrder(database, manager, purchaseOrder.id, purchaseOrder.version + 1);

  // ---- Saturday afternoon: the buns arrive.
  at(DAY, "14:00");
  await receivePurchaseOrder(database, manager, purchaseOrder.id, {
    lines: [{ purchaseOrderLineId: poLine.id, receivedQuantity: "24", actualUnitCost: null }],
    supplierReference: "INV-DAY",
    notes: null,
  });

  // ---- Evening: a walk-in waits, then is seated; the Garcia reservation checks in and is seated.
  at(DAY, "18:30");

  const walkIn = await addToWaitlist(database, host, { guestName: "Walk-in Lee", partySize: 2, quotedWaitMinutes: 15 });

  at(DAY, "18:45");

  const [walkInEntry] = await database.select().from(waitlistEntries).where(eq(waitlistEntries.id, walkIn.id));
  const walkInSeat = await seatWaitlistParty(database, host, {
    entryId: walkIn.id,
    expectedVersion: walkInEntry!.version,
    tableIds: [tableB],
    serverEmployeeId: serverEmployee,
  });

  at(DAY, "18:58");

  const checkedIn = await checkInReservation(database, host, reservation.id, { expectedVersion: confirmed.version });
  const occupancyAfterCheckIn = await database
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(eq(tableSessions.guestPartyId, (await reservationParty(database, reservation.id))!));

  at(DAY, "19:00");

  const garciaSeat = await seatReservationParty(database, host, {
    reservationId: reservation.id,
    expectedVersion: checkedIn.version,
    tableIds: [tableA],
    serverEmployeeId: serverEmployee,
  });

  // ---- The Garcia order: drinks to the Bar, then the appetizer, then the canonical burger.
  at(DAY, "19:05");

  const garcia = await createOrder(database, server, { orderType: "DINE_IN", tableSessionId: garciaSeat.id });
  let garciaVersion = garcia.version;
  const add = async (orderId: string, version: number, menuItemId: string, selections: typeof burger.mediumOnly = []) =>
    (
      await addDraftItem(database, server, orderId, {
        expectedVersion: version,
        menuItemId,
        quantity: 1,
        selections,
        specialInstructions: null,
      })
    ).orderVersion;
  const send = async (orderId: string, version: number, key = newKey()): Promise<DaySend> => ({
    ...(await sendOrderItems(database, server, orderId, { expectedVersion: version, idempotencyKey: key })),
    key,
  });

  garciaVersion = await add(garcia.id, garciaVersion, scenario.cocktail.id);

  const drinks = await send(garcia.id, garciaVersion);

  at(DAY, "19:10");
  garciaVersion = await add(garcia.id, drinks.orderVersion, scenario.fries.id);

  const appetizer = await send(garcia.id, garciaVersion);

  at(DAY, "19:20");
  garciaVersion = await add(garcia.id, appetizer.orderVersion, burger.menuItem.id, burger.canonicalSelections);

  const burgerSend = await send(garcia.id, garciaVersion);

  // ---- Bar and kitchen: Start, Ready, Bump.
  const advance = async (actor: Actor, orderId: string, name: string, steps: [string, "start" | "ready" | "complete"][]) => {
    for (const [time, action] of steps) {
      at(DAY, time);

      const item = await ticketItem(database, orderId, name);

      await transitionTicketItem(database, actor, item.id, action, { expectedVersion: item.version });
    }
  };

  await advance(scenario.bartender, garcia.id, "Margarita", [["19:21", "start"], ["19:24", "ready"], ["19:26", "complete"]]);
  await advance(scenario.cook, garcia.id, "Fries", [["19:22", "start"], ["19:28", "ready"], ["19:30", "complete"]]);
  await advance(scenario.cook, garcia.id, "Bacon Cheeseburger", [["19:23", "start"], ["19:38", "ready"], ["19:40", "complete"]]);

  // ---- Settlement: part cash, the rest on an external card with a tip. The order closes.
  const settle = async (
    orderId: string,
    tenders: Parameters<typeof tender>[3][],
  ) => {
    const opened = await openSettlement(database, server, orderId);

    for (const values of tenders) {
      await tender(database, server, opened.settlementId, values);
    }

    const [row] = await database.select().from(settlements).where(eq(settlements.id, opened.settlementId));

    return completeSettlement(database, server, opened.settlementId, {
      expectedVersion: row!.version,
      idempotencyKey: newKey(),
    });
  };

  at(DAY, "20:30");

  const garciaClosed = await settle(garcia.id, [
    { tenderType: "CASH", amount: "20.00", receivedAmount: "20.00" },
    {
      tenderType: "EXTERNAL_CARD",
      amount: "12.99",
      tipAmount: "5.00",
      providerName: "Square",
      cardBrand: "Visa",
      cardLastFour: "4242",
    },
  ]);
  const garciaSessionAfterClose = await database.select().from(tableSessions).where(eq(tableSessions.id, garciaSeat.id));

  // Guests leave: the session completes, the table is DIRTY, then cleaned.
  at(DAY, "20:45");
  await completeTableSession(database, host, garciaSeat.id, {
    expectedVersion: await versionOf(database, tableSessions, garciaSeat.id),
  });

  const tableAAfterSession = (await database.select().from(restaurantTables).where(eq(restaurantTables.id, tableA)))[0]!;

  at(DAY, "20:55");
  await cleanTable(database, host, tableA, { expectedVersion: tableAAfterSession.version });

  // ---- Takeout: fries, paid by card, no Table Session.
  at(DAY, "21:00");

  const takeout = await createOrder(database, server, { orderType: "TAKEOUT", customerName: "Pat" });
  const takeoutSend = await send(takeout.id, await add(takeout.id, takeout.version, scenario.fries.id));

  await advance(scenario.cook, takeout.id, "Fries", [["21:01", "start"], ["21:06", "ready"], ["21:10", "complete"]]);
  at(DAY, "21:12");

  const takeoutClosed = await settle(takeout.id, [
    { tenderType: "EXTERNAL_CARD", amount: "4.50", providerName: "Square", cardBrand: "Visa", cardLastFour: "1111" },
  ]);

  // ---- The walk-in orders late; the check settles after midnight, before the cutoff.
  at(DAY, "23:50");

  const late = await createOrder(database, server, { orderType: "DINE_IN", tableSessionId: walkInSeat.id });
  const lateSend = await send(late.id, await add(late.id, late.version, burger.menuItem.id, burger.mediumOnly));

  await advance(scenario.cook, late.id, "Bacon Cheeseburger", [["23:51", "start"], ["23:59", "ready"], ["23:59", "complete"]]);
  at(SUNDAY, "00:30");

  const lateClosed = await settle(late.id, [{ tenderType: "CASH", amount: "15.99", receivedAmount: "20.00" }]);

  at(SUNDAY, "00:40");
  await completeTableSession(database, host, walkInSeat.id, {
    expectedVersion: await versionOf(database, tableSessions, walkInSeat.id),
  });
  at(SUNDAY, "00:50");
  await cleanTable(database, host, tableB, { expectedVersion: await versionOf(database, restaurantTables, tableB) });

  return {
    scenario,
    actors: { owner, manager, host, server, reporter, auditor },
    employees: { server: serverEmployee, host: hostEmployee, cook: cookEmployee },
    tables: { a: tableA, b: tableB },
    period,
    reservation: { id: reservation.id },
    occupancyAfterCheckIn,
    purchaseOrder: { id: purchaseOrder.id, lineId: poLine.id },
    sessions: { garcia: garciaSeat.id, walkIn: walkInSeat.id },
    garciaSessionAfterClose: garciaSessionAfterClose[0]!,
    tableAAfterSession,
    orders: {
      garcia: { id: garcia.id, sends: { drinks, appetizer, burger: burgerSend }, closed: garciaClosed },
      takeout: { id: takeout.id, sends: { fries: takeoutSend }, closed: takeoutClosed },
      late: { id: late.id, sends: { burger: lateSend }, closed: lateClosed },
    },
  };
}

async function reservationParty(database: Database, reservationId: string): Promise<string | null> {
  const [row] = await database
    .select({ guestPartyId: reservations.guestPartyId })
    .from(reservations)
    .where(eq(reservations.id, reservationId));

  return row?.guestPartyId ?? null;
}
