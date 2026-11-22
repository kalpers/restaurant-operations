import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import { guestParties, locations, reservations, waitlistEntries } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 34 (policies 11–14, amendment 7): Reservations' free text for a guest erase: special
// requests of other visits, reservation notes and waitlist notes. The erase workflow decides
// what is a mention; these functions only find candidates and redact the chosen rows. The
// erased guest's own visits are cleared outright by the erase itself, so they are left out.

type Scope = { organizationId: string; locationIds: readonly string[]; excludePartyIds: readonly string[] };

const localDate = (instant: unknown) => sql<string>`to_char(${instant} AT TIME ZONE ${locations.timezone}, 'YYYY-MM-DD')`;

function notExcluded(column: Parameters<typeof notInArray>[0], ids: readonly string[]) {
  return ids.length > 0 ? notInArray(column, [...ids]) : undefined;
}

export async function findPartyRequestCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: guestParties.id,
      locationId: guestParties.locationId,
      locationName: locations.name,
      date: localDate(guestParties.createdAt),
      text: guestParties.specialRequests,
    })
    .from(guestParties)
    .innerJoin(locations, eq(locations.id, guestParties.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(guestParties.locationId, [...scope.locationIds]),
        isNotNull(guestParties.specialRequests),
        notExcluded(guestParties.id, scope.excludePartyIds),
        freeTextCondition([sql`${guestParties.specialRequests}`], query),
      ),
    );

  return rows.map((row) => ({ ...row, label: "Special request on a visit", text: row.text ?? "" }));
}

export async function findReservationNoteCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: reservations.id,
      locationId: reservations.locationId,
      locationName: locations.name,
      date: sql<string>`${reservations.businessDate}::text`,
      text: reservations.notes,
    })
    .from(reservations)
    .innerJoin(locations, eq(locations.id, reservations.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(reservations.locationId, [...scope.locationIds]),
        isNotNull(reservations.notes),
        notExcluded(reservations.guestPartyId, scope.excludePartyIds),
        freeTextCondition([sql`${reservations.notes}`], query),
      ),
    );

  return rows.map((row) => ({ ...row, label: "Reservation note", text: row.text ?? "" }));
}

export async function findWaitlistNoteCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: waitlistEntries.id,
      locationId: waitlistEntries.locationId,
      locationName: locations.name,
      date: localDate(waitlistEntries.addedAt),
      text: waitlistEntries.notes,
    })
    .from(waitlistEntries)
    .innerJoin(locations, eq(locations.id, waitlistEntries.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(waitlistEntries.locationId, [...scope.locationIds]),
        isNotNull(waitlistEntries.notes),
        notExcluded(waitlistEntries.guestPartyId, scope.excludePartyIds),
        freeTextCondition([sql`${waitlistEntries.notes}`], query),
      ),
    );

  return rows.map((row) => ({ ...row, label: "Waitlist note", text: row.text ?? "" }));
}

/** Policy 12: replaces the guest's words in one visit's special requests. */
export async function redactPartyRequest(
  transaction: DatabaseTransaction,
  actor: Actor,
  partyId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(guestParties).where(eq(guestParties.id, partyId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "guest_parties", rowId: row.id, reason },
    { specialRequests: { columnName: "special_requests", value: row.specialRequests } },
    redact,
  );

  if (changed.specialRequests !== undefined) {
    await transaction
      .update(guestParties)
      .set({ specialRequests: changed.specialRequests, version: sql`${guestParties.version} + 1`, updatedAt: new Date() })
      .where(eq(guestParties.id, row.id));
  }
}

export async function redactReservationNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  reservationId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(reservations).where(eq(reservations.id, reservationId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "reservations", rowId: row.id, reason },
    { notes: { columnName: "notes", value: row.notes } },
    redact,
  );

  if (changed.notes !== undefined) {
    await transaction
      .update(reservations)
      .set({ notes: changed.notes, version: sql`${reservations.version} + 1`, updatedAt: new Date() })
      .where(eq(reservations.id, row.id));
  }
}

export async function redactWaitlistNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  entryId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "waitlist_entries", rowId: row.id, reason },
    { notes: { columnName: "notes", value: row.notes } },
    redact,
  );

  if (changed.notes !== undefined) {
    await transaction
      .update(waitlistEntries)
      .set({ notes: changed.notes, version: sql`${waitlistEntries.version} + 1`, updatedAt: new Date() })
      .where(eq(waitlistEntries.id, row.id));
  }
}

/**
 * Policy 11: the erased guest's own reservation and waitlist notes are cleared outright, as
 * their special requests already are. Returns how many notes were cleared.
 */
export async function clearOwnVisitNotes(transaction: DatabaseTransaction, partyIds: readonly string[]): Promise<number> {
  if (partyIds.length === 0) {
    return 0;
  }

  const now = new Date();
  const clearedReservations = await transaction
    .update(reservations)
    .set({ notes: null, version: sql`${reservations.version} + 1`, updatedAt: now })
    .where(and(inArray(reservations.guestPartyId, [...partyIds]), isNotNull(reservations.notes)))
    .returning({ id: reservations.id });
  const clearedWaitlist = await transaction
    .update(waitlistEntries)
    .set({ notes: null, version: sql`${waitlistEntries.version} + 1`, updatedAt: now })
    .where(and(inArray(waitlistEntries.guestPartyId, [...partyIds]), isNotNull(waitlistEntries.notes)))
    .returning({ id: waitlistEntries.id });

  return clearedReservations.length + clearedWaitlist.length;
}

/** The visits an erase clears outright: a profile's linked parties, or the one visit. */
export async function readOwnPartyIds(
  executor: DatabaseExecutor,
  target: { profileId: string } | { guestPartyId: string },
): Promise<string[]> {
  if ("guestPartyId" in target) {
    return [target.guestPartyId];
  }

  const rows = await executor.select({ id: guestParties.id }).from(guestParties).where(eq(guestParties.guestProfileId, target.profileId));

  return rows.map((row) => row.id);
}
