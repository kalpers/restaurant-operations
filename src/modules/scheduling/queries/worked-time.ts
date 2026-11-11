import { and, asc, between, eq, inArray, isNull, ne } from "drizzle-orm";

import { timeEntries, timeEntryAdjustments, timeEntryBreaks } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import { workedSeconds, type BreakSpan } from "../rules/time-clock";

// Phase 18: the time clock facts other modules may read (Settlements for tip pools,
// Reporting for actual labor). Worked time is computed by the one rule in
// `rules/time-clock.ts`, never re-derived elsewhere.

export type WorkedEntry = {
  id: string;
  employeeId: string;
  positionId: string;
  shiftAssignmentId: string | null;
  businessDate: string;
  status: "OPEN" | "CLOSED";
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: (BreakSpan & { id: string })[];
  /** CLOSED entries only; an OPEN entry counts zero (policy C18). */
  workedSeconds: number;
  adjusted: boolean;
};

/** Non-voided entries with business dates in [from, to], with their current breaks. */
export async function findWorkedEntries(
  executor: DatabaseExecutor,
  input: { locationId: string; from: string; to: string; employeeIds?: readonly string[] },
): Promise<WorkedEntry[]> {
  if (input.employeeIds?.length === 0) {
    return [];
  }

  const rows = await executor
    .select({
      id: timeEntries.id,
      employeeId: timeEntries.employeeId,
      positionId: timeEntries.positionId,
      shiftAssignmentId: timeEntries.shiftAssignmentId,
      businessDate: timeEntries.businessDate,
      status: timeEntries.status,
      clockInAt: timeEntries.clockInAt,
      clockOutAt: timeEntries.clockOutAt,
      clockOutSource: timeEntries.clockOutSource,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.locationId, input.locationId),
        between(timeEntries.businessDate, input.from, input.to),
        ne(timeEntries.status, "VOIDED"),
        input.employeeIds ? inArray(timeEntries.employeeId, [...input.employeeIds]) : undefined,
      ),
    )
    .orderBy(asc(timeEntries.clockInAt), asc(timeEntries.id));

  const breaks = await findBreaks(
    executor,
    rows.map((row) => row.id),
  );
  const adjustedIds = await findAdjustedEntryIds(
    executor,
    rows.map((row) => row.id),
  );

  return rows.map((row) => {
    const spans = breaks.get(row.id) ?? [];
    const closed = row.status === "CLOSED" && row.clockOutAt !== null;

    return {
      id: row.id,
      employeeId: row.employeeId,
      positionId: row.positionId,
      shiftAssignmentId: row.shiftAssignmentId,
      businessDate: row.businessDate,
      status: row.status as "OPEN" | "CLOSED",
      clockInAt: row.clockInAt,
      clockOutAt: row.clockOutAt,
      breaks: spans,
      workedSeconds: closed ? workedSeconds(row, spans) : 0,
      adjusted: adjustedIds.has(row.id) || row.clockOutSource === "ADJUSTMENT",
    };
  });
}

export async function findBreaks(
  executor: DatabaseExecutor,
  entryIds: readonly string[],
): Promise<Map<string, (BreakSpan & { id: string })[]>> {
  const result = new Map<string, (BreakSpan & { id: string })[]>();

  if (entryIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({
      id: timeEntryBreaks.id,
      timeEntryId: timeEntryBreaks.timeEntryId,
      startedAt: timeEntryBreaks.startedAt,
      endedAt: timeEntryBreaks.endedAt,
      paid: timeEntryBreaks.paid,
    })
    .from(timeEntryBreaks)
    .where(and(inArray(timeEntryBreaks.timeEntryId, [...entryIds]), isNull(timeEntryBreaks.removedAt)))
    .orderBy(asc(timeEntryBreaks.startedAt), asc(timeEntryBreaks.id));

  for (const row of rows) {
    const list = result.get(row.timeEntryId) ?? [];

    list.push({ id: row.id, startedAt: row.startedAt, endedAt: row.endedAt, paid: row.paid });
    result.set(row.timeEntryId, list);
  }

  return result;
}

async function findAdjustedEntryIds(executor: DatabaseExecutor, entryIds: readonly string[]): Promise<Set<string>> {
  if (entryIds.length === 0) {
    return new Set();
  }

  const rows = await executor
    .selectDistinct({ id: timeEntryAdjustments.timeEntryId })
    .from(timeEntryAdjustments)
    .where(inArray(timeEntryAdjustments.timeEntryId, [...entryIds]));

  return new Set(rows.map((row) => row.id));
}

/** Policy D25: whether any entry on this business date is still OPEN. */
export async function hasOpenEntriesOn(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDate: string },
): Promise<boolean> {
  const [row] = await executor
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.locationId, input.locationId),
        eq(timeEntries.businessDate, input.businessDate),
        eq(timeEntries.status, "OPEN"),
      ),
    )
    .limit(1);

  return Boolean(row);
}

/** Policy A10: whether the employee is on the clock anywhere. */
export async function isOnTheClock(executor: DatabaseExecutor, employeeId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, employeeId), eq(timeEntries.status, "OPEN")))
    .limit(1);

  return Boolean(row);
}
