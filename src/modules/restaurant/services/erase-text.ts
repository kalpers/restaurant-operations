import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { checklistRunItems, checklistRuns, locations, tableSessions, temperatureReadings } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, joinTexts, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 34 (policies 11–14, amendment 7): table session notes for a guest erase. Candidates
// only; the erase workflow decides what is a mention. Sessions of the erased guest's own
// visits are cleared outright instead.

export async function findSessionNoteCandidates(
  executor: DatabaseExecutor,
  scope: { organizationId: string; locationIds: readonly string[]; excludePartyIds: readonly string[] },
  query: FreeTextQuery,
): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: tableSessions.id,
      locationId: tableSessions.locationId,
      locationName: locations.name,
      date: sql<string>`to_char(${tableSessions.seatedAt} AT TIME ZONE ${locations.timezone}, 'YYYY-MM-DD')`,
      text: tableSessions.notes,
      guestPartyId: tableSessions.guestPartyId,
    })
    .from(tableSessions)
    .innerJoin(locations, eq(locations.id, tableSessions.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(tableSessions.locationId, [...scope.locationIds]),
        isNotNull(tableSessions.notes),
        freeTextCondition([sql`${tableSessions.notes}`], query),
      ),
    );

  const excluded = new Set(scope.excludePartyIds);

  return rows
    .filter((row) => !row.guestPartyId || !excluded.has(row.guestPartyId))
    .map((row) => ({
      id: row.id,
      locationId: row.locationId,
      locationName: row.locationName,
      date: row.date,
      label: "Table session note",
      text: row.text ?? "",
    }));
}

/** Policy 12: replaces the guest's words in one session's notes. Not a seating change. */
export async function redactSessionNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  sessionId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(tableSessions).where(eq(tableSessions.id, sessionId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "table_sessions", rowId: row.id, reason },
    { notes: { columnName: "notes", value: row.notes } },
    redact,
  );

  if (changed.notes !== undefined) {
    await transaction
      .update(tableSessions)
      .set({ notes: changed.notes, version: sql`${tableSessions.version} + 1`, updatedAt: new Date() })
      .where(eq(tableSessions.id, row.id));
  }
}

/** Policy 11: the erased guest's own sessions lose their notes. Returns how many. */
export async function clearOwnSessionNotes(transaction: DatabaseTransaction, partyIds: readonly string[]): Promise<number> {
  if (partyIds.length === 0) {
    return 0;
  }

  const cleared = await transaction
    .update(tableSessions)
    .set({ notes: null, version: sql`${tableSessions.version} + 1`, updatedAt: new Date() })
    .where(and(inArray(tableSessions.guestPartyId, [...partyIds]), isNotNull(tableSessions.notes)))
    .returning({ id: tableSessions.id });

  return cleared.length;
}


/** Phase 36 (policy 3): checklist item notes and skip reasons, as candidates for a guest erase. */
export async function findChecklistNoteCandidates(
  executor: DatabaseExecutor,
  scope: { organizationId: string; locationIds: readonly string[] },
  query: FreeTextQuery,
): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: checklistRunItems.id,
      locationId: checklistRuns.locationId,
      locationName: locations.name,
      date: checklistRuns.businessDate,
      templateName: checklistRuns.templateNameSnapshot,
      note: checklistRunItems.note,
      skipReason: checklistRunItems.skipReason,
    })
    .from(checklistRunItems)
    .innerJoin(checklistRuns, eq(checklistRuns.id, checklistRunItems.runId))
    .innerJoin(locations, eq(locations.id, checklistRuns.locationId))
    .where(
      and(
        eq(checklistRuns.organizationId, scope.organizationId),
        inArray(checklistRuns.locationId, [...scope.locationIds]),
        or(isNotNull(checklistRunItems.note), isNotNull(checklistRunItems.skipReason)),
        freeTextCondition([sql`${checklistRunItems.note}`, sql`${checklistRunItems.skipReason}`], query),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `Checklist note (${row.templateName})`,
    text: joinTexts(row.note, row.skipReason),
  }));
}

/** Phase 36 (policy 3): replaces the guest's words in one checklist item's note and skip reason. */
export async function redactChecklistNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  runItemId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(checklistRunItems).where(eq(checklistRunItems.id, runItemId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "checklist_run_items", rowId: row.id, reason },
    {
      note: { columnName: "note", value: row.note },
      skipReason: { columnName: "skip_reason", value: row.skipReason },
    },
    redact,
  );

  if (changed.note !== undefined || changed.skipReason !== undefined) {
    await transaction
      .update(checklistRunItems)
      .set({ ...changed, version: sql`${checklistRunItems.version} + 1` })
      .where(eq(checklistRunItems.id, row.id));
  }
}

/** Phase 36 (policy 3): temperature corrective actions, as candidates for a guest erase. */
export async function findTemperatureActionCandidates(
  executor: DatabaseExecutor,
  scope: { organizationId: string; locationIds: readonly string[] },
  query: FreeTextQuery,
): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: temperatureReadings.id,
      locationId: temperatureReadings.locationId,
      locationName: locations.name,
      date: temperatureReadings.businessDate,
      pointName: temperatureReadings.pointNameSnapshot,
      text: temperatureReadings.correctiveAction,
    })
    .from(temperatureReadings)
    .innerJoin(locations, eq(locations.id, temperatureReadings.locationId))
    .where(
      and(
        eq(temperatureReadings.organizationId, scope.organizationId),
        inArray(temperatureReadings.locationId, [...scope.locationIds]),
        isNotNull(temperatureReadings.correctiveAction),
        freeTextCondition([sql`${temperatureReadings.correctiveAction}`], query),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `Temperature corrective action (${row.pointName})`,
    text: row.text ?? "",
  }));
}

/** Phase 36 (policy 3): replaces the guest's words in one reading's corrective action. */
export async function redactTemperatureAction(
  transaction: DatabaseTransaction,
  actor: Actor,
  readingId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(temperatureReadings).where(eq(temperatureReadings.id, readingId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "temperature_readings", rowId: row.id, reason },
    { correctiveAction: { columnName: "corrective_action", value: row.correctiveAction } },
    redact,
  );

  if (changed.correctiveAction !== undefined) {
    await transaction.update(temperatureReadings).set({ correctiveAction: changed.correctiveAction }).where(eq(temperatureReadings.id, row.id));
  }
}
