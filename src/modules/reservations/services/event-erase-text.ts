import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { eventBookings, locations } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordFreeTextRedaction, redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, joinTexts, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

import { formatEventNumber } from "../rules/event-rules";

// Phase 36 (policy 3): events' free text for a guest erase. Other events' names, notes, menu
// notes and deposit references are searched (where the eraser holds `events.view`) and only the
// guest's words become "[redacted]". The guest's own events are cleared outright: the name
// becomes the event number and the notes go. Every change writes a `free_text_redactions` row,
// which a completed or cancelled event's guard requires.

const TEXT_COLUMNS = {
  name: "name",
  notes: "notes",
  menuNotes: "menu_notes",
  depositReference: "deposit_reference",
  cancelReason: "cancel_reason",
} as const;

export async function findEventTextCandidates(
  executor: DatabaseExecutor,
  scope: { organizationId: string; locationIds: readonly string[]; excludePartyIds: readonly string[] },
  query: FreeTextQuery,
): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: eventBookings.id,
      locationId: eventBookings.locationId,
      locationName: locations.name,
      date: eventBookings.businessDate,
      eventNumber: eventBookings.eventNumber,
      name: eventBookings.name,
      notes: eventBookings.notes,
      menuNotes: eventBookings.menuNotes,
      depositReference: eventBookings.depositReference,
      cancelReason: eventBookings.cancelReason,
    })
    .from(eventBookings)
    .innerJoin(locations, eq(locations.id, eventBookings.locationId))
    .where(
      and(
        eq(eventBookings.organizationId, scope.organizationId),
        inArray(eventBookings.locationId, [...scope.locationIds]),
        scope.excludePartyIds.length > 0 ? notInArray(eventBookings.guestPartyId, [...scope.excludePartyIds]) : undefined,
        freeTextCondition(
          [
            sql`${eventBookings.name}`,
            sql`${eventBookings.notes}`,
            sql`${eventBookings.menuNotes}`,
            sql`${eventBookings.depositReference}`,
            sql`${eventBookings.cancelReason}`,
          ],
          query,
        ),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `Event ${formatEventNumber(row.eventNumber)}`,
    text: joinTexts(row.name, row.notes, row.menuNotes, row.depositReference, row.cancelReason),
  }));
}

/** Replaces the guest's words in one other event's text. */
export async function redactEventText(
  transaction: DatabaseTransaction,
  actor: Actor,
  eventId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(eventBookings).where(eq(eventBookings.id, eventId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "event_bookings", rowId: row.id, reason },
    {
      name: { columnName: TEXT_COLUMNS.name, value: row.name },
      notes: { columnName: TEXT_COLUMNS.notes, value: row.notes },
      menuNotes: { columnName: TEXT_COLUMNS.menuNotes, value: row.menuNotes },
      depositReference: { columnName: TEXT_COLUMNS.depositReference, value: row.depositReference },
      cancelReason: { columnName: TEXT_COLUMNS.cancelReason, value: row.cancelReason },
    },
    redact,
  );

  if (Object.keys(changed).length > 0) {
    await transaction
      .update(eventBookings)
      .set({ ...changed, version: sql`${eventBookings.version} + 1` })
      .where(eq(eventBookings.id, row.id));
  }
}

/** Policy 3: the erased guest's own events lose their name (it becomes the number) and notes. Returns how many. */
export async function clearOwnEventText(
  transaction: DatabaseTransaction,
  actor: Actor,
  partyIds: readonly string[],
  reason: string,
): Promise<number> {
  if (partyIds.length === 0) {
    return 0;
  }

  const rows = await transaction
    .select()
    .from(eventBookings)
    .where(inArray(eventBookings.guestPartyId, [...partyIds]))
    .for("update");
  let cleared = 0;

  for (const row of rows) {
    const next = {
      name: `Event ${formatEventNumber(row.eventNumber)}`,
      notes: null,
      menuNotes: null,
      depositReference: null,
      // A cancelled event keeps a reason (the database requires one), emptied of words.
      cancelReason: row.cancelReason === null ? null : "[redacted]",
    };
    const changed = (Object.keys(TEXT_COLUMNS) as (keyof typeof TEXT_COLUMNS)[]).filter((key) => row[key] !== next[key]);

    if (changed.length === 0) {
      continue;
    }

    for (const key of changed) {
      await recordFreeTextRedaction(transaction, actor, { tableName: "event_bookings", rowId: row.id, columnName: TEXT_COLUMNS[key], reason });
    }

    await transaction
      .update(eventBookings)
      .set({ ...next, version: sql`${eventBookings.version} + 1` })
      .where(eq(eventBookings.id, row.id));
    cleared += 1;
  }

  return cleared;
}
