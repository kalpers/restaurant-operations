import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "../src/db";
import {
  CANONICAL_BURGER,
  VALIDATION_DINER,
  VALIDATION_EMPLOYEES,
  VALIDATION_PARTY,
  VALIDATION_PERIOD,
  VALIDATION_SECTION,
  VALIDATION_SEED_KEY,
  VALIDATION_TAKEOUT,
} from "../src/db/demo/validation-fixture";
import {
  employees,
  guestParties,
  kitchenTicketItems,
  locations,
  menuItems,
  modifierGroups,
  modifiers,
  orders,
  positions,
  reservations,
  schedulePeriods,
  seedRuns,
  serverSectionAssignments,
  serverSections,
  settlements,
  shiftAssignments,
  shifts,
  tableSessions,
} from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { changeCompensation } from "../src/modules/employees/services/compensation-service";
import { createEmployee } from "../src/modules/employees/services/employee-service";
import { transitionTicketItem } from "../src/modules/kitchen/services/fulfillment-service";
import { addDraftItem } from "../src/modules/orders/services/draft-item-service";
import { createOrder } from "../src/modules/orders/services/order-service";
import {
  checkInReservation,
  createReservation,
} from "../src/modules/reservations/services/reservation-service";
import { getFloorStatus } from "../src/modules/restaurant/services/floor-service";
import { assignServerToSection } from "../src/modules/restaurant/services/section-service";
import { cleanTable } from "../src/modules/restaurant/services/table-service";
import { addRecurringAvailability } from "../src/modules/scheduling/services/availability-service";
import { assignEmployee, createPeriod, createShift, publishPeriod } from "../src/modules/scheduling/services/schedule-service";
import {
  createDrawer,
  getDrawerSetting,
  listDrawers,
  openDrawerSession,
} from "../src/modules/settlements/services/drawer-service";
import { openSettlement, recordTender } from "../src/modules/settlements/services/settlement-service";
import { addDays, localDateOf, localTimeOf } from "../src/shared/time/zoned-time";
import { completeSettlement } from "../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../src/workflows/end-table-session/end-table-session";
import { seatReservationParty } from "../src/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "../src/workflows/submit-order/submit-order";

import { seedDemoKitchen } from "./demo-kitchen";

export type ValidationSeedResult =
  | { skipped: true }
  | { skipped: false; employees: number; schedule: boolean; dineIn: boolean; takeout: boolean; upcoming: boolean };

const key = () => `validation-${randomUUID()}`;

/**
 * Phase 13's validation fixture, built through the application's services as the MAIN
 * Owner, so every ledger row, balance, snapshot, ticket, settlement and audit event is the
 * one the real workflow writes. Each step first checks whether an earlier run already did
 * it, so an interrupted run resumes without duplicates; a finished run is recorded under
 * VALIDATION_SEED_KEY and skipped from then on.
 *
 * Services commit their own transactions (they take the database, not a transaction), so
 * the fixture is not one transaction. That is the trade for writing nothing directly.
 */
export async function seedValidationFixture(database: Database, actor: Actor): Promise<ValidationSeedResult> {
  const [done] = await database.select({ id: seedRuns.id }).from(seedRuns).where(eq(seedRuns.seedKey, VALIDATION_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  // The menu, recipes, modifiers, stations and opening stock (idempotent on its own).
  await seedDemoKitchen(database, actor);

  const [location] = await database
    .select({ id: locations.id, timeZone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, actor.locationId));
  const positionIds = new Map(
    (await database.select({ id: positions.id, code: positions.code }).from(positions).where(eq(positions.organizationId, actor.organizationId))).map(
      (row) => [row.code, row.id],
    ),
  );
  const positionId = (code: string) => {
    const id = positionIds.get(code);

    if (!id) {
      throw new Error(`Position ${code} does not exist. Run \`npm run db:seed\` first.`);
    }

    return id;
  };

  // ---- Employees with an hourly wage for their position, available every day.
  const employeeIds = new Map<string, string>();
  let createdEmployees = 0;

  for (const person of VALIDATION_EMPLOYEES) {
    const [existing] = await database
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.organizationId, actor.organizationId), eq(employees.employeeNumber, person.employeeNumber)));

    if (existing) {
      employeeIds.set(person.position, existing.id);
      continue;
    }

    const employee = await createEmployee(database, actor, {
      employeeNumber: person.employeeNumber,
      firstName: person.firstName,
      middleName: null,
      lastName: person.lastName,
      preferredName: null,
      workEmail: null,
      hireDate: "2024-01-15",
      employmentType: "PART_TIME",
      positionId: positionId(person.position),
    });

    await changeCompensation(database, actor, {
      employeeId: employee.id,
      positionId: positionId(person.position),
      compensationType: "HOURLY",
      hourlyRate: person.hourlyRate,
      annualSalary: null,
      effectiveFrom: "2024-01-15",
      changeReason: "Phase 13 validation fixture",
    });

    for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
      await addRecurringAvailability(
        database,
        actor,
        { kind: "employee", employeeId: employee.id },
        {
          dayOfWeek,
          startTime: "00:00",
          endTime: "00:00",
          availabilityType: "AVAILABLE",
          effectiveFrom: "2024-01-15",
          effectiveTo: null,
          thisLocationOnly: false,
        },
      );
    }

    employeeIds.set(person.position, employee.id);
    createdEmployees += 1;
  }

  // ---- The published 2030 week, one filled shift per person.
  const schedule = await ensurePublishedWeek(database, actor, positionId, employeeIds);

  // ---- The validation server works the Dining A section (an explicit schedule override,
  // because the 2030 shift isn't running now).
  const serverId = employeeIds.get("SERVER")!;
  const [section] = await database
    .select({ id: serverSections.id })
    .from(serverSections)
    .where(and(eq(serverSections.locationId, actor.locationId), eq(serverSections.code, VALIDATION_SECTION)));
  const [assigned] = await database
    .select({ id: serverSectionAssignments.id })
    .from(serverSectionAssignments)
    .where(and(eq(serverSectionAssignments.employeeId, serverId), isNull(serverSectionAssignments.effectiveTo)));

  if (section && !assigned) {
    await assignServerToSection(database, actor, section.id, {
      employeeId: serverId,
      scheduleOverrideReason: "Phase 13 validation fixture",
    });
  }

  const burger = await canonicalBurger(database, actor);

  // ---- A completed dine-in visit: reservation, check-in, seating, the canonical burger,
  // kitchen, cash settlement, the guests leave, the table is cleaned.
  const [diner] = await database
    .select({ id: reservations.id, status: reservations.status })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(and(eq(reservations.locationId, actor.locationId), eq(guestParties.guestName, VALIDATION_DINER)));
  let dineIn = false;

  if (!diner) {
    const now = new Date();
    const soon = new Date(now.getTime() + 10 * 60_000);
    const table = (await getFloorStatus(database, actor)).find(
      (candidate) => candidate.area.type === "DINING" && candidate.availability === "AVAILABLE" && candidate.capacity >= 2,
    );

    if (!table) {
      throw new Error("No clean, unoccupied dining table at MAIN for the validation visit.");
    }

    const reservation = await createReservation(database, actor, {
      guestName: VALIDATION_DINER,
      partySize: 2,
      source: "PHONE",
      expectedDurationMinutes: 60,
      localDate: localDateOf(soon, location!.timeZone),
      localTime: localTimeOf(soon, location!.timeZone),
      status: "CONFIRMED",
    });
    const checkedIn = await checkInReservation(database, actor, reservation.id, { expectedVersion: reservation.version });
    const seated = await seatReservationParty(database, actor, {
      reservationId: reservation.id,
      expectedVersion: checkedIn.version,
      tableIds: [table.id],
      serverEmployeeId: null,
    });
    const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: seated.id });

    await sellAndSettle(database, actor, order, burger);

    const [session] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, seated.id));

    await completeTableSession(database, actor, seated.id, { expectedVersion: session!.version });

    const dirty = (await getFloorStatus(database, actor)).find((candidate) => candidate.id === table.id)!;

    await cleanTable(database, actor, table.id, { expectedVersion: dirty.version });
    dineIn = true;
  } else if (diner.status !== "COMPLETED") {
    throw new Error(
      `An earlier run left the "${VALIDATION_DINER}" reservation ${diner.status}. Finish or cancel that visit in the app, then run this again.`,
    );
  }

  // ---- A takeout check for the same burger.
  const [takeoutOrder] = await database
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.locationId, actor.locationId), eq(orders.customerName, VALIDATION_TAKEOUT)));
  let takeout = false;

  if (!takeoutOrder) {
    const order = await createOrder(database, actor, { orderType: "TAKEOUT", customerName: VALIDATION_TAKEOUT });

    await sellAndSettle(database, actor, order, burger);
    takeout = true;
  } else if (takeoutOrder.status !== "CLOSED") {
    throw new Error(`An earlier run left the "${VALIDATION_TAKEOUT}" order ${takeoutOrder.status}. Settle or void it in the app, then run this again.`);
  }

  // ---- The upcoming reservation, CONFIRMED and planned on T02, for check-in tests.
  const [party] = await database
    .select({ id: reservations.id })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(and(eq(reservations.locationId, actor.locationId), eq(guestParties.guestName, VALIDATION_PARTY.guestName)));
  let upcoming = false;

  if (!party) {
    const t02 = (await getFloorStatus(database, actor)).find((candidate) => candidate.tableNumber === VALIDATION_PARTY.tableNumber);

    await createReservation(database, actor, {
      guestName: VALIDATION_PARTY.guestName,
      partySize: VALIDATION_PARTY.partySize,
      source: "PHONE",
      expectedDurationMinutes: 90,
      localDate: addDays(localDateOf(new Date(), location!.timeZone), 1),
      localTime: VALIDATION_PARTY.localTime,
      status: "CONFIRMED",
      tableIds: t02 ? [t02.id] : [],
    });
    upcoming = true;
  }

  await database.insert(seedRuns).values({ seedKey: VALIDATION_SEED_KEY }).onConflictDoNothing({ target: seedRuns.seedKey });

  return { skipped: false, employees: createdEmployees, schedule, dineIn, takeout, upcoming };
}

async function ensurePublishedWeek(
  database: Database,
  actor: Actor,
  positionId: (code: string) => string,
  employeeIds: Map<string, string>,
): Promise<boolean> {
  const find = async () =>
    (
      await database
        .select()
        .from(schedulePeriods)
        .where(and(eq(schedulePeriods.locationId, actor.locationId), eq(schedulePeriods.name, VALIDATION_PERIOD.name)))
    )[0];
  let period = await find();

  if (period?.status === "PUBLISHED" || period?.status === "ARCHIVED") {
    return false;
  }

  if (!period) {
    await createPeriod(database, actor, {
      name: VALIDATION_PERIOD.name,
      startDate: VALIDATION_PERIOD.startDate,
      endDate: VALIDATION_PERIOD.endDate,
    });
    period = (await find())!;
  }

  for (const planned of VALIDATION_PERIOD.shifts) {
    const employeeId = employeeIds.get(planned.position)!;
    const [existing] = await database
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.schedulePeriodId, period.id), eq(shifts.positionId, positionId(planned.position))));
    const shiftId =
      existing?.id ??
      (
        await createShift(database, actor, period.id, {
          positionId: positionId(planned.position),
          restaurantAreaId: null,
          shiftDate: VALIDATION_PERIOD.shiftDate,
          startTime: planned.startTime,
          endTime: planned.endTime,
          requiredEmployeeCount: 1,
          courseOrStationNote: null,
          notes: null,
          priority: 0,
          expectedPeriodVersion: (await find())!.version,
        })
      ).id;
    const [assignment] = await database
      .select({ id: shiftAssignments.id })
      .from(shiftAssignments)
      .where(and(eq(shiftAssignments.shiftId, shiftId), eq(shiftAssignments.employeeId, employeeId)));

    if (!assignment) {
      await assignEmployee(database, actor, shiftId, { employeeId, notes: null, expectedPeriodVersion: (await find())!.version });
    }
  }

  await publishPeriod(database, actor, period.id, { expectedVersion: (await find())!.version });

  return true;
}

type Burger = { menuItemId: string; selections: { modifierGroupId: string; modifierId: string }[] };

async function canonicalBurger(database: Database, actor: Actor): Promise<Burger> {
  const [item] = await database
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, actor.organizationId), eq(menuItems.code, CANONICAL_BURGER.menuItem)));
  const groups = new Map(
    (
      await database
        .select({ id: modifierGroups.id, code: modifierGroups.code })
        .from(modifierGroups)
        .where(
          and(
            eq(modifierGroups.organizationId, actor.organizationId),
            inArray(modifierGroups.code, CANONICAL_BURGER.selections.map((selection) => selection.group)),
          ),
        )
    ).map((row) => [row.code, row.id]),
  );
  const choices = new Map(
    (
      await database
        .select({ id: modifiers.id, code: modifiers.code })
        .from(modifiers)
        .where(
          and(
            eq(modifiers.organizationId, actor.organizationId),
            inArray(modifiers.code, CANONICAL_BURGER.selections.map((selection) => selection.modifier)),
          ),
        )
    ).map((row) => [row.code, row.id]),
  );

  if (!item || groups.size < 3 || choices.size < 4) {
    throw new Error("The demo kitchen's Bacon Cheeseburger and its modifiers are missing.");
  }

  return {
    menuItemId: item.id,
    selections: CANONICAL_BURGER.selections.map((selection) => ({
      modifierGroupId: groups.get(selection.group)!,
      modifierId: choices.get(selection.modifier)!,
    })),
  };
}

/**
 * Phase 17: where the location requires a drawer for cash, the fixture's cash goes into an
 * open "VALIDATION" drawer session, created once and reused on a second run.
 */
async function validationDrawerSession(database: Database, actor: Actor): Promise<string | null> {
  if (!(await getDrawerSetting(database, actor)).required) {
    return null;
  }

  const drawer =
    (await listDrawers(database, actor)).find((entry) => entry.code === "VALIDATION") ??
    { ...(await createDrawer(database, actor, { code: "VALIDATION", name: "Validation register" })), openSession: null };

  return (
    drawer.openSession?.id ??
    (await openDrawerSession(database, actor, drawer.id, { openingFloat: "100.00", idempotencyKey: key() })).id
  );
}

/** Adds the canonical burger, sends it, runs it through the kitchen and settles in cash. */
async function sellAndSettle(database: Database, actor: Actor, order: { id: string; version: number }, burger: Burger) {
  const drafted = await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId: burger.menuItemId,
    quantity: 1,
    selections: burger.selections,
    specialInstructions: null,
  });

  await sendOrderItems(database, actor, order.id, { expectedVersion: drafted.orderVersion, idempotencyKey: key() });

  for (const action of ["start", "ready", "complete"] as const) {
    const items = await database.select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, order.id));

    for (const item of items) {
      await transitionTicketItem(database, actor, item.id, action, { expectedVersion: item.version });
    }
  }

  const opened = await openSettlement(database, actor, order.id);
  const recorded = await recordTender(database, actor, opened.settlementId, {
    idempotencyKey: key(),
    expectedVersion: opened.settlementVersion,
    tenderType: "CASH",
    outcome: "RECORDED",
    amount: opened.orderAmountSnapshot,
    tipAmount: null,
    receivedAmount: opened.orderAmountSnapshot,
    externalReference: null,
    providerName: null,
    cardBrand: null,
    cardLastFour: null,
    authorizationReference: null,
    otherDescription: null,
    failureReason: null,
    cashDrawerSessionId: await validationDrawerSession(database, actor),
  });
  const [settlement] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, opened.settlementId));

  await completeSettlement(database, actor, opened.settlementId, {
    expectedVersion: settlement?.version ?? recorded.settlementVersion,
    idempotencyKey: key(),
  });
}
