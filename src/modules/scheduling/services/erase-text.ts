import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { locations, positions, shiftAssignments, shifts } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, joinTexts, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 34 (policies 11–14, amendments 5, 7): schedule notes for a guest erase. Candidates
// only; the erase workflow decides what is a mention. A redaction isn't a schedule change: it
// works at any period status, sends no notification and leaves the period's version alone.

type Scope = { organizationId: string; locationIds: readonly string[] };

export async function findShiftNoteCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: shifts.id,
      locationId: shifts.locationId,
      locationName: locations.name,
      date: sql<string>`${shifts.shiftDate}::text`,
      position: positions.name,
      notes: shifts.notes,
      courseNote: shifts.courseOrStationNote,
    })
    .from(shifts)
    .innerJoin(locations, eq(locations.id, shifts.locationId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(shifts.locationId, [...scope.locationIds]),
        or(isNotNull(shifts.notes), isNotNull(shifts.courseOrStationNote)),
        freeTextCondition([sql`${shifts.notes}`, sql`${shifts.courseOrStationNote}`], query),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `${row.position} shift note`,
    text: joinTexts(row.courseNote, row.notes),
  }));
}

export async function findAssignmentNoteCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: shiftAssignments.id,
      locationId: shifts.locationId,
      locationName: locations.name,
      date: sql<string>`${shifts.shiftDate}::text`,
      position: positions.name,
      text: shiftAssignments.notes,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(locations, eq(locations.id, shifts.locationId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(shifts.locationId, [...scope.locationIds]),
        isNotNull(shiftAssignments.notes),
        freeTextCondition([sql`${shiftAssignments.notes}`], query),
      ),
    );

  return rows.map(({ position, ...row }) => ({ ...row, label: `${position} shift assignment note`, text: row.text ?? "" }));
}

/** Amendment 5: replaces the guest's words in a shift's notes, at any period status. */
export async function redactShiftNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  shiftId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(shifts).where(eq(shifts.id, shiftId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "shifts", rowId: row.id, reason },
    {
      notes: { columnName: "notes", value: row.notes },
      courseOrStationNote: { columnName: "course_or_station_note", value: row.courseOrStationNote },
    },
    redact,
  );

  if (Object.keys(changed).length > 0) {
    await transaction
      .update(shifts)
      .set({ ...changed, version: sql`${shifts.version} + 1`, updatedAt: new Date() })
      .where(eq(shifts.id, row.id));
  }
}

export async function redactAssignmentNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  assignmentId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(shiftAssignments).where(eq(shiftAssignments.id, assignmentId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "shift_assignments", rowId: row.id, reason },
    { notes: { columnName: "notes", value: row.notes } },
    redact,
  );

  if (changed.notes !== undefined) {
    await transaction
      .update(shiftAssignments)
      .set({ notes: changed.notes, version: sql`${shiftAssignments.version} + 1`, updatedAt: new Date() })
      .where(eq(shiftAssignments.id, row.id));
  }
}
