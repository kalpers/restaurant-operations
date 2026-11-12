import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { idempotencyRecords, schedulePeriods, timeEntries, timeEntryBreaks } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { assignEmployee, createPeriod, createShift, publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { addDays, localDateOf, localMinutesOf } from "@/shared/time/zoned-time";

// Phase 18 time clock fixtures. Fixture locations use America/Detroit and a 4:00 AM cutoff.

export const FIXTURE_TIME_ZONE = "America/Detroit";

export function key(): string {
  return `test_${randomUUID().replaceAll("-", "")}`;
}

function hhmm(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;

  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

async function periodVersion(database: Database, periodId: string): Promise<number> {
  const [row] = await database
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

/**
 * A PUBLISHED shift for the employee starting `offsetMinutes` from now (local time), three
 * hours long, so a clock-in now can match it. Each call uses its own one-week period.
 */
export async function publishShiftNearNow(
  database: Database,
  owner: Actor,
  input: { employeeId: string; positionId: string; offsetMinutes?: number; durationMinutes?: number },
): Promise<{ shiftId: string; assignmentId: string; periodId: string }> {
  const start = new Date(Date.now() + (input.offsetMinutes ?? 0) * 60_000);
  const shiftDate = localDateOf(start, FIXTURE_TIME_ZONE);
  const startMinutes = localMinutesOf(start, FIXTURE_TIME_ZONE);
  const period = await createPeriod(database, owner, {
    name: `Time clock ${randomUUID().slice(0, 8)}`,
    startDate: shiftDate,
    endDate: addDays(shiftDate, 6),
  });
  const shift = await createShift(database, owner, period.id, {
    positionId: input.positionId,
    restaurantAreaId: null,
    shiftDate,
    startTime: hhmm(startMinutes),
    endTime: hhmm(startMinutes + (input.durationMinutes ?? 180)),
    requiredEmployeeCount: 1,
    courseOrStationNote: null,
    notes: null,
    priority: 0,
    expectedPeriodVersion: period.version,
  });
  const { id } = await assignEmployee(database, owner, shift.id, {
    employeeId: input.employeeId,
    notes: null,
    expectedPeriodVersion: await periodVersion(database, period.id),
  });

  await publishPeriod(database, owner, period.id, { expectedVersion: await periodVersion(database, period.id) });

  return { shiftId: shift.id, assignmentId: id, periodId: period.id };
}

/**
 * A CLOSED entry at a past instant, written straight to the table the way the service would
 * (OPEN at the punch instant, then closed), for report and tip fixtures.
 */
export async function insertClosedEntry(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    positionId: string;
    businessDate: string;
    clockInAt: Date;
    clockOutAt: Date;
    shiftAssignmentId?: string | null;
    unpaidBreak?: { startedAt: Date; endedAt: Date };
  },
): Promise<string> {
  return database.transaction(async (transaction) => {
    const [record] = await transaction
      .insert(idempotencyRecords)
      .values({
        organizationId: actor.organizationId,
        scope: "timeclock.clock-in",
        idempotencyKey: key(),
        actorUserId: actor.userId,
        requestFingerprint: "fixture",
        response: {},
      })
      .returning({ id: idempotencyRecords.id });
    const [entry] = await transaction
      .insert(timeEntries)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        employeeId: input.employeeId,
        positionId: input.positionId,
        shiftAssignmentId: input.shiftAssignmentId ?? null,
        businessDate: input.businessDate,
        clockInAt: input.clockInAt,
        clockInRecordedAt: input.clockInAt,
        clockInSource: "MANAGER",
        clockInByUserId: actor.userId,
        clockInIdempotencyRecordId: record!.id,
      })
      .returning({ id: timeEntries.id });

    if (input.unpaidBreak) {
      await transaction.insert(timeEntryBreaks).values({
        timeEntryId: entry!.id,
        startedAt: input.unpaidBreak.startedAt,
        endedAt: input.unpaidBreak.endedAt,
        paid: false,
        recordedByUserId: actor.userId,
      });
    }

    await transaction
      .update(timeEntries)
      .set({
        status: "CLOSED",
        clockOutAt: input.clockOutAt,
        clockOutRecordedAt: input.clockOutAt,
        clockOutSource: "MANAGER",
        clockOutByUserId: actor.userId,
      })
      .where(eq(timeEntries.id, entry!.id));

    return entry!.id;
  });
}

/** Phase 20: an OPEN entry clocked in at a past instant, such as a missed clock-out. */
export async function insertOpenEntry(
  database: Database,
  actor: Actor,
  input: { employeeId: string; positionId: string; businessDate: string; clockInAt: Date },
): Promise<string> {
  return database.transaction(async (transaction) => {
    const [record] = await transaction
      .insert(idempotencyRecords)
      .values({
        organizationId: actor.organizationId,
        scope: "timeclock.clock-in",
        idempotencyKey: key(),
        actorUserId: actor.userId,
        requestFingerprint: "fixture",
        response: {},
      })
      .returning({ id: idempotencyRecords.id });
    const [entry] = await transaction
      .insert(timeEntries)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        employeeId: input.employeeId,
        positionId: input.positionId,
        businessDate: input.businessDate,
        clockInAt: input.clockInAt,
        clockInRecordedAt: input.clockInAt,
        clockInSource: "MANAGER",
        clockInByUserId: actor.userId,
        clockInIdempotencyRecordId: record!.id,
      })
      .returning({ id: timeEntries.id });

    return entry!.id;
  });
}
