import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import {
  allergens,
  eventBookingTables,
  eventBookings,
  eventNumberCounters,
  guestParties,
  guestPartyAllergies,
  menuItems,
  reservations,
  restaurantAreas,
  restaurantTables,
} from "@/db/schema";
import type { EventDepositMethod, EventSpaceScope, EventStatus } from "@/db/schema/events";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { sumPartyCheckSubtotals } from "@/modules/orders/queries/party-spend";
import { assertNoCardNumber } from "@/modules/restaurant/rules/manager-log-rules";
import { lockTablesAtLocation } from "@/modules/restaurant/services/seating-checks";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays, localDateOf, localTimeOf, localToInstant } from "@/shared/time/zoned-time";

import { findEventBlocks, lockLocationPlanning, type EventBlock } from "../queries/event-blocks";
import { appendPartyHistory, changePartyStatus } from "../repositories/party-repository";
import { findPlanningConflicts, readReservationContext, type ReservationContext } from "../repositories/reservation-repository";
import {
  assertDepositRecord,
  assertEventOpen,
  assertEventTimes,
  assertEventTransition,
  eventBlockInterval,
  eventBlocks,
  formatEventNumber,
} from "../rules/event-rules";
import { intervalsOverlap, reservationPlanningInterval } from "../rules/hold-intervals";
import type { Interval } from "../types";
import { attachProfileToParty } from "./guest-profile-service";
import { actorHolds, assertPermission } from "./guest-access";

// Phase 36 part 3 (policy 7): event and private-dining bookings. An event is its own Guest
// Party, planned like a reservation. TENTATIVE and CONFIRMED events hold their space; moving to
// either, or changing the time or space while in either, is refused on any clash with planned
// reservations or other events (no override: move them first). Deposits and minimum spend are
// information only. Every write takes the location's planning lock.

type EventRow = typeof eventBookings.$inferSelect;

const PLANNING_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;

export type EventInput = {
  name: string;
  guestName: string;
  partySize: number;
  phone?: string | null;
  email?: string | null;
  guestProfileId?: string | null;
  localDate: string;
  startTime: string;
  endTime: string;
  setupMinutes: number;
  teardownMinutes: number;
  spaceScope: EventSpaceScope;
  restaurantAreaId?: string | null;
  tableIds?: string[];
  notes?: string | null;
  menuNotes?: string | null;
  menuItemId?: string | null;
  minimumSpend?: string | null;
  depositAgreed?: string | null;
  depositReceived?: string | null;
  depositReceivedOn?: string | null;
  depositMethod?: EventDepositMethod | null;
  depositReference?: string | null;
};

export type EventView = {
  id: string;
  eventNumber: string;
  name: string;
  status: EventStatus;
  spaceScope: EventSpaceScope;
  area: { id: string; name: string } | null;
  tables: { id: string; tableNumber: string }[];
  startsAt: string;
  endsAt: string;
  localDate: string;
  startTime: string;
  endTime: string;
  setupMinutes: number;
  teardownMinutes: number;
  blockStartsAt: string;
  blockEndsAt: string;
  businessDate: string;
  guestPartyId: string;
  partyStatus: string;
  guestName: string;
  partySize: number;
  /** Only for `guests.contact.view` holders. */
  contact: { phone: string | null; email: string | null } | null;
  allergies: { name: string; severity: string }[];
  notes: string | null;
  menuNotes: string | null;
  menuItem: { id: string; name: string } | null;
  minimumSpend: string | null;
  depositAgreed: string | null;
  depositReceived: string | null;
  depositReceivedOn: string | null;
  depositMethod: EventDepositMethod | null;
  depositReference: string | null;
  cancelReason: string | null;
  version: number;
};

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/** Local start and end on a date; an end at or before the start runs past midnight. */
function eventInstants(context: ReservationContext, input: Pick<EventInput, "localDate" | "startTime" | "endTime">) {
  const startsAt = localToInstant(input.localDate, input.startTime, context.timeZone);
  const endDate = input.endTime <= input.startTime ? addDays(input.localDate, 1) : input.localDate;
  const endsAt = localToInstant(endDate, input.endTime, context.timeZone);

  if (!startsAt || !endsAt) {
    throw new BusinessRuleError("EVENT_TIME_DOES_NOT_EXIST", "That local time doesn't exist on that date because the clocks change.");
  }

  return { startsAt, endsAt, businessDate: businessDateOf(startsAt, context) };
}

async function nextEventNumber(transaction: DatabaseTransaction, organizationId: string): Promise<number> {
  await transaction.insert(eventNumberCounters).values({ organizationId }).onConflictDoNothing();

  const [row] = await transaction
    .update(eventNumberCounters)
    .set({ lastNumber: sql`${eventNumberCounters.lastNumber} + 1` })
    .where(eq(eventNumberCounters.organizationId, organizationId))
    .returning({ lastNumber: eventNumberCounters.lastNumber });

  return row!.lastNumber;
}

/** Policy 7: the space's area and held tables, locked. A buyout locks nothing and holds no table. */
async function resolveSpace(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: Pick<EventInput, "spaceScope" | "restaurantAreaId" | "tableIds">,
): Promise<{ areaId: string | null; tableIds: string[] }> {
  if (input.spaceScope === "LOCATION") {
    return { areaId: null, tableIds: [] };
  }

  let tableIds: string[];

  if (input.spaceScope === "AREA") {
    const [area] = await transaction
      .select()
      .from(restaurantAreas)
      .where(and(eq(restaurantAreas.id, input.restaurantAreaId ?? ""), eq(restaurantAreas.locationId, actor.locationId)));

    if (!area) {
      throw new NotFoundError("area");
    }

    if (!area.active || area.areaType === "TAKEOUT") {
      throw new BusinessRuleError("EVENT_AREA_INVALID", "Choose an active dining or bar area.");
    }

    tableIds = (
      await transaction
        .select({ id: restaurantTables.id })
        .from(restaurantTables)
        .where(and(eq(restaurantTables.restaurantAreaId, area.id), eq(restaurantTables.active, true)))
    ).map((row) => row.id);

    if (tableIds.length === 0) {
      throw new BusinessRuleError("EVENT_AREA_INVALID", "That area has no tables in use.");
    }
  } else {
    tableIds = [...new Set(input.tableIds ?? [])];

    if (tableIds.length === 0) {
      throw new BusinessRuleError("EVENT_TABLES_REQUIRED", "Choose the tables the event uses.");
    }
  }

  const tables = await lockTablesAtLocation(transaction, actor.locationId, tableIds);

  if (tables.length !== tableIds.length) {
    throw new NotFoundError("table");
  }

  const areaIds = new Set(tables.map((table) => table.restaurantAreaId));

  if (tables.some((table) => !table.active || !table.areaActive || table.areaType === "TAKEOUT")) {
    throw new BusinessRuleError("TABLE_INACTIVE", "Every table must be in use, in a dining or bar area.");
  }

  // Policy 7 (C1): an event's space is in one area unless it's a buyout.
  if (areaIds.size !== 1) {
    throw new BusinessRuleError("EVENT_ONE_AREA", "An event's tables are all in one area. Book the whole location for more.");
  }

  return { areaId: [...areaIds][0]!, tableIds };
}

/** Reservations still being planned whose planning interval overlaps `interval`, on these tables or anywhere. */
async function overlappingReservations(
  executor: DatabaseExecutor,
  actor: Actor,
  context: ReservationContext,
  input: { interval: Interval; tableIds: readonly string[] | null; exceptGuestPartyId: string; now: Date },
): Promise<{ guestName: string; reservationAt: Date }[]> {
  if (input.tableIds) {
    return (
      await findPlanningConflicts(executor, {
        locationId: actor.locationId,
        tableIds: input.tableIds,
        interval: input.interval,
        settings: context,
        now: input.now,
      })
    ).map((conflict) => ({ guestName: conflict.guestName, reservationAt: conflict.reservationAt }));
  }

  const rows = await executor
    .select({
      guestName: guestParties.guestName,
      guestPartyId: reservations.guestPartyId,
      reservationAt: reservations.reservationAt,
      expectedDurationMinutes: reservations.expectedDurationMinutes,
    })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.locationId, actor.locationId),
        inArray(reservations.status, [...PLANNING_STATUSES]),
        gte(reservations.reservationAt, new Date(input.interval.start.getTime() - 24 * 3_600_000)),
        lte(reservations.reservationAt, input.interval.end),
      ),
    );

  return rows.filter(
    (row) => row.guestPartyId !== input.exceptGuestPartyId && intervalsOverlap(reservationPlanningInterval(row, context), input.interval),
  );
}

function describeClashes(
  context: ReservationContext,
  clashes: { reservations: { guestName: string; reservationAt: Date }[]; events: EventBlock[] },
): string {
  const time = (at: Date) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: context.timeZone }).format(at);
  const parts = [
    ...clashes.reservations.slice(0, 3).map((row) => `the ${time(row.reservationAt)} reservation for ${row.guestName}`),
    ...clashes.events.slice(0, 3).map((block) => `${block.eventNumber} ${block.name}`),
  ];
  const more = clashes.reservations.length + clashes.events.length - parts.length;

  return `This space is already planned: ${parts.join("; ")}${more > 0 ? ` and ${more} more` : ""}. Move them first.`;
}

/** Policy 7: an event may hold its space only if nothing else is planned there for its interval. */
async function assertSpaceFree(
  transaction: DatabaseTransaction,
  actor: Actor,
  context: ReservationContext,
  event: { id: string | null; guestPartyId: string; scope: EventSpaceScope; tableIds: string[]; interval: Interval; now: Date },
): Promise<void> {
  const tables = event.scope === "LOCATION" ? null : event.tableIds;
  const clashes = {
    reservations: await overlappingReservations(transaction, actor, context, {
      interval: event.interval,
      tableIds: tables,
      exceptGuestPartyId: event.guestPartyId,
      now: event.now,
    }),
    events: await findEventBlocks(transaction, {
      locationId: actor.locationId,
      interval: event.interval,
      tableIds: tables,
      buyouts: "include",
      exceptEventId: event.id,
    }),
  };

  if (clashes.reservations.length + clashes.events.length > 0) {
    throw new ConflictError("EVENT_CONFLICT", describeClashes(context, clashes));
  }
}

async function replaceTables(transaction: DatabaseTransaction, eventId: string, scope: EventSpaceScope, tableIds: readonly string[]) {
  await transaction.delete(eventBookingTables).where(eq(eventBookingTables.eventBookingId, eventId));

  if (scope === "TABLES" && tableIds.length > 0) {
    await transaction.insert(eventBookingTables).values(tableIds.map((restaurantTableId) => ({ eventBookingId: eventId, restaurantTableId })));
  }
}

function eventFields(input: EventInput) {
  const fields = {
    name: input.name.trim(),
    notes: blankToNull(input.notes),
    menuNotes: blankToNull(input.menuNotes),
    menuItemId: input.menuItemId ?? null,
    minimumSpend: blankToNull(input.minimumSpend),
    depositAgreed: blankToNull(input.depositAgreed),
    depositReceived: blankToNull(input.depositReceived),
    depositReceivedOn: blankToNull(input.depositReceivedOn),
    depositMethod: input.depositMethod ?? null,
    depositReference: blankToNull(input.depositReference),
    setupMinutes: input.setupMinutes,
    teardownMinutes: input.teardownMinutes,
    spaceScope: input.spaceScope,
  };

  assertNoCardNumber(fields.name, fields.notes, fields.menuNotes, fields.depositReference);
  assertDepositRecord(fields);

  if (fields.depositReceived === null && fields.depositReference !== null) {
    throw new BusinessRuleError("DEPOSIT_INCOMPLETE", "A deposit reference goes with a received deposit.");
  }

  return fields;
}

async function assertMenuItem(executor: DatabaseExecutor, actor: Actor, menuItemId: string | null) {
  if (!menuItemId) {
    return;
  }

  const [item] = await executor
    .select({ id: menuItems.id, active: menuItems.active })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }

  if (!item.active) {
    throw new BusinessRuleError("MENU_ITEM_INACTIVE", "That menu item is no longer in the catalog.");
  }
}

// ------------------------------------------------------------------------------ Reading

async function viewsOf(executor: DatabaseExecutor, actor: Actor, rows: readonly EventRow[]): Promise<EventView[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const partyIds = rows.map((row) => row.guestPartyId);
  const menuItemIds = [...new Set(rows.map((row) => row.menuItemId).filter((id): id is string => id !== null))];
  const context = await readReservationContext(executor, actor.locationId);
  const [parties, tableRows, areaRows, itemRows, allergyRows] = await Promise.all([
    executor.select().from(guestParties).where(inArray(guestParties.id, partyIds)),
    executor
      .select({ eventId: eventBookingTables.eventBookingId, id: restaurantTables.id, tableNumber: restaurantTables.tableNumber })
      .from(eventBookingTables)
      .innerJoin(restaurantTables, eq(restaurantTables.id, eventBookingTables.restaurantTableId))
      .where(inArray(eventBookingTables.eventBookingId, ids))
      .orderBy(asc(restaurantTables.tableNumber)),
    executor
      .select({ id: restaurantAreas.id, name: restaurantAreas.name })
      .from(restaurantAreas)
      .where(eq(restaurantAreas.locationId, actor.locationId)),
    menuItemIds.length === 0
      ? Promise.resolve([])
      : executor.select({ id: menuItems.id, name: menuItems.name }).from(menuItems).where(inArray(menuItems.id, menuItemIds)),
    executor
      .select({ partyId: guestPartyAllergies.guestPartyId, name: allergens.name, severity: guestPartyAllergies.severity })
      .from(guestPartyAllergies)
      .innerJoin(allergens, eq(allergens.id, guestPartyAllergies.allergenId))
      .where(inArray(guestPartyAllergies.guestPartyId, partyIds)),
  ]);
  const party = new Map(parties.map((row) => [row.id, row]));
  const areas = new Map(areaRows.map((row) => [row.id, row]));
  const items = new Map(itemRows.map((row) => [row.id, row]));
  const contact = actorHolds(actor, "guests.contact.view");

  return rows.map((row) => {
    const guest = party.get(row.guestPartyId)!;
    const block = eventBlockInterval(row);
    const area = row.restaurantAreaId ? (areas.get(row.restaurantAreaId) ?? null) : null;

    return {
      id: row.id,
      eventNumber: formatEventNumber(row.eventNumber),
      name: row.name,
      status: row.status as EventStatus,
      spaceScope: row.spaceScope as EventSpaceScope,
      area: area ? { id: area.id, name: area.name } : null,
      tables: tableRows.filter((table) => table.eventId === row.id).map(({ id, tableNumber }) => ({ id, tableNumber })),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      localDate: localDateOf(row.startsAt, context.timeZone),
      startTime: localTimeOf(row.startsAt, context.timeZone).slice(0, 5),
      endTime: localTimeOf(row.endsAt, context.timeZone).slice(0, 5),
      setupMinutes: row.setupMinutes,
      teardownMinutes: row.teardownMinutes,
      blockStartsAt: block.start.toISOString(),
      blockEndsAt: block.end.toISOString(),
      businessDate: row.businessDate,
      guestPartyId: row.guestPartyId,
      partyStatus: guest.status,
      guestName: guest.guestName,
      partySize: guest.partySize,
      contact: contact ? { phone: guest.phone, email: guest.email } : null,
      allergies: allergyRows.filter((allergy) => allergy.partyId === row.guestPartyId).map(({ name, severity }) => ({ name, severity })),
      notes: row.notes,
      menuNotes: row.menuNotes,
      menuItem: row.menuItemId ? (items.get(row.menuItemId) ?? null) : null,
      minimumSpend: row.minimumSpend,
      depositAgreed: row.depositAgreed,
      depositReceived: row.depositReceived,
      depositReceivedOn: row.depositReceivedOn,
      depositMethod: row.depositMethod as EventDepositMethod | null,
      depositReference: row.depositReference,
      cancelReason: row.cancelReason,
      version: row.version,
    };
  });
}

/** Policy 7: events starting in a range of business dates (up to 62 days), soonest first. */
export async function listEvents(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: { from: string; to: string; status?: EventStatus | null },
): Promise<EventView[]> {
  assertPermission(actor, "events.view");

  if (filter.to < filter.from || Date.parse(filter.to) - Date.parse(filter.from) > 61 * 86_400_000) {
    throw new BusinessRuleError("RANGE_TOO_LONG", "Show up to 62 days at a time.");
  }

  const rows = await executor
    .select()
    .from(eventBookings)
    .where(
      and(
        eq(eventBookings.locationId, actor.locationId),
        gte(eventBookings.businessDate, filter.from),
        lte(eventBookings.businessDate, filter.to),
        filter.status ? eq(eventBookings.status, filter.status) : undefined,
      ),
    )
    .orderBy(asc(eventBookings.startsAt));

  return viewsOf(executor, actor, rows);
}

async function findEvent(executor: DatabaseExecutor, actor: Actor, eventId: string): Promise<EventRow> {
  const [row] = await executor
    .select()
    .from(eventBookings)
    .where(and(eq(eventBookings.id, eventId), eq(eventBookings.locationId, actor.locationId)));

  if (!row) {
    throw new NotFoundError("event");
  }

  return row;
}

/** One event, with what its party's checks come to so far against the minimum spend. */
export async function getEvent(
  executor: DatabaseExecutor,
  actor: Actor,
  eventId: string,
): Promise<EventView & { spend: { subtotal: string; checks: number } }> {
  assertPermission(actor, "events.view");

  const row = await findEvent(executor, actor, eventId);
  const [view] = await viewsOf(executor, actor, [row]);

  return { ...view!, spend: await sumPartyCheckSubtotals(executor, row.guestPartyId) };
}

// ------------------------------------------------------------------------------ Writing

async function lockEvent(transaction: DatabaseTransaction, actor: Actor, eventId: string, expectedVersion: number): Promise<EventRow> {
  const [row] = await transaction
    .select()
    .from(eventBookings)
    .where(and(eq(eventBookings.id, eventId), eq(eventBookings.locationId, actor.locationId)))
    .for("update");

  if (!row) {
    throw new NotFoundError("event");
  }

  if (row.version !== expectedVersion) {
    throw new ConflictError("CONCURRENCY_CONFLICT", "This event was changed by someone else. Reload and try again.");
  }

  return row;
}

/** Policy 7: books an event as an inquiry, a tentative hold or confirmed, with its own party. */
export async function createEvent(
  database: Database,
  actor: Actor,
  input: EventInput & { status?: "INQUIRY" | "TENTATIVE" | "CONFIRMED" },
): Promise<EventView> {
  assertPermission(actor, "events.manage");

  const fields = eventFields(input);
  const status = input.status ?? "INQUIRY";

  const eventId = await withTransaction(database, async (transaction) => {
    await lockLocationPlanning(transaction, actor.locationId);

    const now = new Date();
    const context = await readReservationContext(transaction, actor.locationId);
    const times = eventInstants(context, input);

    assertEventTimes({ ...times, setupMinutes: input.setupMinutes, teardownMinutes: input.teardownMinutes });
    await assertMenuItem(transaction, actor, fields.menuItemId);

    const space = await resolveSpace(transaction, actor, input);
    const [party] = await transaction
      .insert(guestParties)
      .values({
        locationId: actor.locationId,
        partySize: input.partySize,
        guestName: input.guestName.trim(),
        phone: blankToNull(input.phone),
        email: blankToNull(input.email),
        status: "EXPECTED",
      })
      .returning({ id: guestParties.id });

    await appendPartyHistory(transaction, { partyId: party!.id, status: "EXPECTED", reason: "Event booked", userId: actor.userId, occurredAt: now });

    if (input.guestProfileId) {
      await attachProfileToParty(transaction, actor, { guestPartyId: party!.id, guestProfileId: input.guestProfileId });
    }

    if (eventBlocks(status)) {
      await assertSpaceFree(transaction, actor, context, {
        id: null,
        guestPartyId: party!.id,
        scope: input.spaceScope,
        tableIds: space.tableIds,
        interval: eventBlockInterval({ ...times, ...fields }),
        now,
      });
    }

    const [row] = await transaction
      .insert(eventBookings)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        guestPartyId: party!.id,
        eventNumber: await nextEventNumber(transaction, actor.organizationId),
        status,
        restaurantAreaId: space.areaId,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        businessDate: times.businessDate,
        ...fields,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning();

    await replaceTables(transaction, row!.id, input.spaceScope, space.tableIds);
    await recordAudit(transaction, actor, {
      action: "reservations.event-created",
      entityId: row!.id,
      details: {
        eventNumber: formatEventNumber(row!.eventNumber),
        status,
        spaceScope: input.spaceScope,
        businessDate: times.businessDate,
        guestCount: input.partySize,
      },
    });

    return row!.id;
  });

  return getEvent(database, actor, eventId);
}

const AUDITED_FIELDS = [
  "name",
  "startsAt",
  "endsAt",
  "setupMinutes",
  "teardownMinutes",
  "spaceScope",
  "restaurantAreaId",
  "notes",
  "menuNotes",
  "menuItemId",
  "minimumSpend",
  "depositAgreed",
  "depositReceived",
  "depositReceivedOn",
  "depositMethod",
  "depositReference",
] as const;

/** Policy 7: changes an open event; a held event's new time or space must be free. */
export async function updateEvent(
  database: Database,
  actor: Actor,
  eventId: string,
  input: Omit<EventInput, "guestProfileId"> & { expectedVersion: number },
): Promise<EventView> {
  assertPermission(actor, "events.manage");

  const fields = eventFields(input);

  await withTransaction(database, async (transaction) => {
    await lockLocationPlanning(transaction, actor.locationId);

    const event = await lockEvent(transaction, actor, eventId, input.expectedVersion);

    assertEventOpen(event.status as EventStatus);

    const now = new Date();
    const context = await readReservationContext(transaction, actor.locationId);
    const times = eventInstants(context, input);

    assertEventTimes({ ...times, setupMinutes: input.setupMinutes, teardownMinutes: input.teardownMinutes });
    await assertMenuItem(transaction, actor, fields.menuItemId);

    const space = await resolveSpace(transaction, actor, input);

    if (eventBlocks(event.status as EventStatus)) {
      await assertSpaceFree(transaction, actor, context, {
        id: event.id,
        guestPartyId: event.guestPartyId,
        scope: input.spaceScope,
        tableIds: space.tableIds,
        interval: eventBlockInterval({ ...times, ...fields }),
        now,
      });
    }

    const [party] = await transaction.select().from(guestParties).where(eq(guestParties.id, event.guestPartyId)).for("update");

    await transaction
      .update(guestParties)
      .set({
        guestName: input.guestName.trim(),
        partySize: input.partySize,
        phone: blankToNull(input.phone),
        email: blankToNull(input.email),
        version: nextVersion(guestParties.version),
      })
      .where(eq(guestParties.id, party!.id));

    const next = { ...fields, restaurantAreaId: space.areaId, startsAt: times.startsAt, endsAt: times.endsAt };
    const changed = AUDITED_FIELDS.filter((key) => String(next[key] ?? "") !== String(event[key] ?? ""));

    assertVersionMatched(
      await transaction
        .update(eventBookings)
        .set({ ...next, businessDate: times.businessDate, updatedByUserId: actor.userId, version: nextVersion(eventBookings.version) })
        .where(and(eq(eventBookings.id, event.id), eq(eventBookings.version, input.expectedVersion)))
        .returning({ id: eventBookings.id }),
      { type: "event", id: event.id },
    );
    await replaceTables(transaction, event.id, input.spaceScope, space.tableIds);
    await recordAudit(transaction, actor, {
      action: "reservations.event-updated",
      entityId: event.id,
      details: {
        eventNumber: formatEventNumber(event.eventNumber),
        changedFields: [
          ...changed,
          ...(party!.guestName !== input.guestName.trim() ? ["guestName"] : []),
          ...(party!.partySize !== input.partySize ? ["guestCount"] : []),
          ...(party!.phone !== blankToNull(input.phone) || party!.email !== blankToNull(input.email) ? ["contact"] : []),
        ],
      },
    });
  });

  return getEvent(database, actor, eventId);
}

/**
 * Policy 7: moves an event to INQUIRY, TENTATIVE, CONFIRMED or CANCELLED. Holding the space
 * needs it to be free; cancelling needs a reason and cancels the party. Never COMPLETED: that
 * comes only from the event's table session ending.
 */
export async function changeEventStatus(
  database: Database,
  actor: Actor,
  eventId: string,
  input: { status: "INQUIRY" | "TENTATIVE" | "CONFIRMED" | "CANCELLED"; reason?: string | null; expectedVersion: number },
): Promise<EventView> {
  assertPermission(actor, "events.manage");

  await withTransaction(database, async (transaction) => {
    await lockLocationPlanning(transaction, actor.locationId);

    const event = await lockEvent(transaction, actor, eventId, input.expectedVersion);
    const from = event.status as EventStatus;
    const now = new Date();

    assertEventTransition(from, input.status);

    const reason = input.reason?.trim() ?? "";

    if (input.status === "CANCELLED" && (!reason || reason.length > 500)) {
      throw new BusinessRuleError("REASON_REQUIRED", "Give a reason for cancelling, up to 500 characters.");
    }

    assertNoCardNumber(reason);

    if (eventBlocks(input.status) && !eventBlocks(from)) {
      const context = await readReservationContext(transaction, actor.locationId);
      const space = await resolveSpace(transaction, actor, {
        spaceScope: event.spaceScope as EventSpaceScope,
        restaurantAreaId: event.restaurantAreaId,
        tableIds: (
          await transaction
            .select({ id: eventBookingTables.restaurantTableId })
            .from(eventBookingTables)
            .where(eq(eventBookingTables.eventBookingId, event.id))
        ).map((row) => row.id),
      });

      await assertSpaceFree(transaction, actor, context, {
        id: event.id,
        guestPartyId: event.guestPartyId,
        scope: event.spaceScope as EventSpaceScope,
        tableIds: space.tableIds,
        interval: eventBlockInterval(event),
        now,
      });
    }

    if (input.status === "CANCELLED") {
      const [party] = await transaction.select().from(guestParties).where(eq(guestParties.id, event.guestPartyId)).for("update");

      if (party!.status === "SEATED") {
        throw new BusinessRuleError("EVENT_SEATED", "This event's party is seated. End its table session first.");
      }

      await changePartyStatus(transaction, {
        party: party!,
        status: "CANCELLED",
        reason: "Event cancelled",
        userId: actor.userId,
        occurredAt: now,
      });
    }

    assertVersionMatched(
      await transaction
        .update(eventBookings)
        .set({
          status: input.status,
          ...(input.status === "CANCELLED" ? { cancelledAt: now, cancelledByUserId: actor.userId, cancelReason: reason } : {}),
          updatedByUserId: actor.userId,
          version: nextVersion(eventBookings.version),
        })
        .where(and(eq(eventBookings.id, event.id), eq(eventBookings.version, input.expectedVersion)))
        .returning({ id: eventBookings.id }),
      { type: "event", id: event.id },
    );
    await recordAudit(transaction, actor, {
      action: "reservations.event-status-changed",
      entityId: event.id,
      details: { eventNumber: formatEventNumber(event.eventNumber), fromStatus: from, toStatus: input.status, reasonLength: reason.length },
    });
  });

  return getEvent(database, actor, eventId);
}

/** For seating: the party's event, locked, which must be CONFIRMED. Null for a party with no event. */
export async function lockEventForSeating(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: { eventId: string; expectedVersion: number },
): Promise<EventRow> {
  const event = await lockEvent(transaction, actor, input.eventId, input.expectedVersion);

  if (event.status !== "CONFIRMED") {
    throw new BusinessRuleError("EVENT_NOT_CONFIRMED", "Confirm this event before seating its party.");
  }

  return event;
}

/** The tables an event's space holds (an AREA event's active tables), for seating. */
export async function eventSpaceTableIds(executor: DatabaseExecutor, event: Pick<EventRow, "id" | "spaceScope" | "restaurantAreaId">) {
  if (event.spaceScope === "AREA") {
    return (
      await executor
        .select({ id: restaurantTables.id })
        .from(restaurantTables)
        .where(and(eq(restaurantTables.restaurantAreaId, event.restaurantAreaId!), eq(restaurantTables.active, true)))
    ).map((row) => row.id);
  }

  return (
    await executor
      .select({ id: eventBookingTables.restaurantTableId })
      .from(eventBookingTables)
      .where(eq(eventBookingTables.eventBookingId, event.id))
  ).map((row) => row.id);
}

/** Policy 7: when the event's party finishes its visit, the event is COMPLETED. */
export async function completeEventForParty(transaction: DatabaseTransaction, guestPartyId: string, at: Date): Promise<void> {
  await transaction
    .update(eventBookings)
    .set({ status: "COMPLETED", completedAt: at, version: nextVersion(eventBookings.version) })
    .where(and(eq(eventBookings.guestPartyId, guestPartyId), inArray(eventBookings.status, ["CONFIRMED", "TENTATIVE"])));
}
