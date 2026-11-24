import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { eventBookingTables, eventBookings, restaurantTables } from "@/db/schema";
import { EVENT_BLOCKING_STATUSES, type EventSpaceScope } from "@/db/schema/events";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";

import { eventBlockInterval, formatEventNumber } from "../rules/event-rules";
import { intervalsOverlap } from "../rules/hold-intervals";
import type { Interval } from "../types";

// Phase 36 (policy 7): the one place an event's hold on its space is decided. Reservation
// planning, waitlist choices, seating, table suggestions, online booking and the demand
// forecast all read event blocks from here, beside (never mixed into) reservation holds.

export type EventBlock = {
  eventId: string;
  eventNumber: string;
  name: string;
  scope: EventSpaceScope;
  guestPartyId: string;
  interval: Interval;
  /** The tables held. Empty for a buyout, which holds no table but blocks bookings. */
  tableIds: string[];
};

/**
 * Serializes reservation, online booking and event writes at one location, so an event can't
 * be confirmed over a reservation made at the same moment (or the other way round).
 */
export async function lockLocationPlanning(transaction: DatabaseTransaction, locationId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`location-planning:${locationId}`}, 0))`);
}

/** The active tables of TABLES and AREA events, by event. */
async function tablesOf(executor: DatabaseExecutor, events: readonly { id: string; spaceScope: string; restaurantAreaId: string | null }[]) {
  const result = new Map<string, string[]>();
  const tableEvents = events.filter((event) => event.spaceScope === "TABLES").map((event) => event.id);
  const areaIds = [...new Set(events.filter((event) => event.spaceScope === "AREA").map((event) => event.restaurantAreaId!))];

  if (tableEvents.length > 0) {
    const rows = await executor
      .select({ eventId: eventBookingTables.eventBookingId, tableId: eventBookingTables.restaurantTableId })
      .from(eventBookingTables)
      .where(inArray(eventBookingTables.eventBookingId, tableEvents));

    for (const row of rows) {
      result.set(row.eventId, [...(result.get(row.eventId) ?? []), row.tableId]);
    }
  }

  if (areaIds.length > 0) {
    const rows = await executor
      .select({ areaId: restaurantTables.restaurantAreaId, tableId: restaurantTables.id })
      .from(restaurantTables)
      .where(and(inArray(restaurantTables.restaurantAreaId, areaIds), eq(restaurantTables.active, true)));

    for (const event of events.filter((entry) => entry.spaceScope === "AREA")) {
      result.set(
        event.id,
        rows.filter((row) => row.areaId === event.restaurantAreaId).map((row) => row.tableId),
      );
    }
  }

  return result;
}

/**
 * Event blocks overlapping `interval` at a location. With `tableIds`, only blocks holding one of
 * those tables, plus buyouts when `buyouts` is "include". Without, every block.
 */
export async function findEventBlocks(
  executor: DatabaseExecutor,
  input: {
    locationId: string;
    interval: Interval;
    tableIds?: readonly string[] | null;
    buyouts: "include" | "exclude";
    exceptEventId?: string | null;
    exceptGuestPartyId?: string | null;
  },
): Promise<EventBlock[]> {
  const rows = await executor
    .select()
    .from(eventBookings)
    .where(
      and(
        eq(eventBookings.locationId, input.locationId),
        inArray(eventBookings.status, [...EVENT_BLOCKING_STATUSES]),
        input.exceptEventId ? ne(eventBookings.id, input.exceptEventId) : undefined,
        input.exceptGuestPartyId ? ne(eventBookings.guestPartyId, input.exceptGuestPartyId) : undefined,
        // A coarse filter; the exact half-open comparison is made below.
        sql`${eventBookings.startsAt} - make_interval(mins => ${eventBookings.setupMinutes}::int) < ${input.interval.end.toISOString()}::timestamptz`,
        sql`${eventBookings.endsAt} + make_interval(mins => ${eventBookings.teardownMinutes}::int) > ${input.interval.start.toISOString()}::timestamptz`,
      ),
    );
  const overlapping = rows.filter((row) => intervalsOverlap(eventBlockInterval(row), input.interval));
  const tables = await tablesOf(executor, overlapping);
  const wanted = input.tableIds ? new Set(input.tableIds) : null;

  return overlapping
    .map((row) => ({
      eventId: row.id,
      eventNumber: formatEventNumber(row.eventNumber),
      name: row.name,
      scope: row.spaceScope as EventSpaceScope,
      guestPartyId: row.guestPartyId,
      interval: eventBlockInterval(row),
      tableIds: tables.get(row.id) ?? [],
    }))
    .filter((block) =>
      block.scope === "LOCATION"
        ? input.buyouts === "include"
        : wanted === null || block.tableIds.some((tableId) => wanted.has(tableId)),
    )
    .sort((a, b) => a.interval.start.getTime() - b.interval.start.getTime());
}

/** Tables held by an event at `now` for anyone but the event's own party (buyouts hold none). */
export async function findEventHeldTableIds(
  executor: DatabaseExecutor,
  input: { locationId: string; now: Date; exceptGuestPartyId?: string | null },
): Promise<Set<string>> {
  const blocks = await findEventBlocks(executor, {
    locationId: input.locationId,
    interval: { start: input.now, end: new Date(input.now.getTime() + 1) },
    buyouts: "exclude",
    exceptGuestPartyId: input.exceptGuestPartyId,
  });

  return new Set(blocks.flatMap((block) => block.tableIds));
}
