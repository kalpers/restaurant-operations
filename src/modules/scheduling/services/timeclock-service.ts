import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import {
  employees,
  locations,
  locationSettings,
  positions,
  schedulePeriods,
  shiftAssignments,
  shifts,
  timeEntries,
  timeEntryAdjustments,
  timeEntryBreaks,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  findSchedulingFacts,
  lockEmployeesForScheduling,
  type SchedulingEmployeeFacts,
} from "@/modules/employees/queries/scheduling-facts";
import { findFinalizedTipDates } from "@/modules/settlements/queries/tip-facts";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf, type BusinessDateSettings } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";

import { findBreaks, findWorkedEntries, type WorkedEntry } from "../queries/worked-time";
import { findRulesRow } from "../repositories/config-repository";
import { DEFAULT_RULE_ROW, weekStartOf } from "../rules/schedule-rules";
import {
  hoursToSeconds,
  matchShift,
  overtimeState,
  SHIFT_MATCH_WINDOW_MS,
  workedSeconds,
  type OvertimeState,
} from "../rules/time-clock";
import { actorHolds, assertPermission, resolveSelfEmployeeId } from "./access";

// Phase 18 time clock (approved policies A1-A12, B17). Self punches resolve the employee from
// the signed-in user's link and never take an employee ID from the request; manager punches
// need `timeclock.manage` and are audited. Effective times may be corrected later, but the
// recorded punch instants never change (trigger in migration 0036).

export const CLOCK_IN_SCOPE = "timeclock.clock-in";
export const CLOCK_OUT_SCOPE = "timeclock.clock-out";
export const BREAK_SCOPE = "timeclock.break";

type EntryRow = typeof timeEntries.$inferSelect;

export type ClockSettings = BusinessDateSettings & {
  thresholdSeconds: number;
  /** Phase 20 (policy 19): null when daily overtime is off. */
  dailyThresholdSeconds: number | null;
  weekStartDay: number;
  overtimeMultiplier: string;
  lateClockInGraceMinutes: number;
};

/** A location, as the actor's or as the periodic check names it (Phase 20). */
type LocationRef = Pick<Actor, "organizationId" | "locationId">;

export async function loadClockSettings(executor: DatabaseExecutor, actor: LocationRef): Promise<ClockSettings> {
  const [row] = await executor
    .select({ timeZone: locations.timezone, businessDayCutoff: locationSettings.businessDayCutoff })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(and(eq(locations.id, actor.locationId), eq(locations.organizationId, actor.organizationId)));

  if (!row) {
    throw new NotFoundError("location");
  }

  const rules = (await findRulesRow(executor, actor.locationId)) ?? DEFAULT_RULE_ROW;

  return {
    timeZone: row.timeZone,
    businessDayCutoff: row.businessDayCutoff,
    thresholdSeconds: hoursToSeconds(rules.weeklyOvertimeThreshold),
    dailyThresholdSeconds: rules.dailyOvertimeThreshold ? hoursToSeconds(rules.dailyOvertimeThreshold) : null,
    weekStartDay: rules.weekStartDay,
    overtimeMultiplier: rules.overtimeMultiplier,
    lateClockInGraceMinutes: rules.lateClockInGraceMinutes,
  };
}

// ------------------------------------------------------------------ eligibility

function coversDate(row: { effectiveFrom: string; effectiveTo: string | null }, date: string): boolean {
  return row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo >= date);
}

/** Positions the employee holds at the location on the business date. */
function heldPositionIds(facts: SchedulingEmployeeFacts, locationId: string, date: string): string[] {
  return [
    ...new Set(
      facts.positions
        .filter((position) => position.locationId === locationId && coversDate(position, date))
        .map((position) => position.positionId),
    ),
  ];
}

/** Policy A4: ACTIVE, eligible at the location, and holding the position, on the business date. */
async function resolveEligiblePosition(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  businessDate: string,
  requestedPositionId: string | null,
): Promise<{ facts: SchedulingEmployeeFacts; positionId: string }> {
  const [facts] = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds: [employeeId],
  });

  if (!facts) {
    throw new NotFoundError("employee");
  }

  const atLocation = facts.locations.some(
    (location) => location.locationId === actor.locationId && coversDate(location, businessDate),
  );
  const held = heldPositionIds(facts, actor.locationId, businessDate);

  if (facts.employmentStatus !== "ACTIVE" || !atLocation || held.length === 0) {
    throw new BusinessRuleError(
      "TIMECLOCK_NOT_ELIGIBLE",
      "This employee can't clock in here: they must be active, work at this location and hold a position here.",
    );
  }

  if (requestedPositionId === null) {
    if (held.length > 1) {
      throw new BusinessRuleError("POSITION_REQUIRED", "Choose the position being worked.");
    }

    return { facts, positionId: held[0]! };
  }

  if (!held.includes(requestedPositionId)) {
    throw new BusinessRuleError("TIMECLOCK_NOT_ELIGIBLE", "This employee doesn't hold that position here.");
  }

  return { facts, positionId: requestedPositionId };
}

async function assertTipsNotFinalized(executor: DatabaseExecutor, actor: Actor, dates: readonly string[]) {
  const finalized = await findFinalizedTipDates(executor, { locationId: actor.locationId, businessDates: dates });

  if (finalized.length > 0) {
    throw new BusinessRuleError(
      "TIP_DISTRIBUTION_FINALIZED",
      `Tips for ${finalized.sort().join(", ")} are finalized. Void that distribution before changing hours.`,
      { businessDates: finalized },
    );
  }
}

async function findShiftCandidates(
  executor: DatabaseExecutor,
  employeeId: string,
  locationId: string,
  instant: Date,
) {
  const from = new Date(instant.getTime() - SHIFT_MATCH_WINDOW_MS);
  const to = new Date(instant.getTime() + SHIFT_MATCH_WINDOW_MS);

  return executor
    .select({
      assignmentId: shiftAssignments.id,
      positionId: shifts.positionId,
      locationId: shifts.locationId,
      startAt: shifts.startAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shiftAssignments.employeeId, employeeId),
        eq(shiftAssignments.status, "ACTIVE"),
        eq(shifts.locationId, locationId),
        isNull(shifts.cancelledAt),
        eq(schedulePeriods.status, "PUBLISHED"),
        gte(shifts.startAt, from),
        lte(shifts.startAt, to),
      ),
    );
}

// ------------------------------------------------------------------ overtime state

export type WeekSummary = {
  weekStart: string;
  weekEnd: string;
  workedSeconds: number;
  thresholdSeconds: number;
  state: OvertimeState;
};

/** Policy B17: closed hours this week plus the open entry's elapsed time. */
async function weekSummary(
  executor: DatabaseExecutor,
  actor: LocationRef,
  settings: ClockSettings,
  employeeId: string,
  now: Date,
): Promise<WeekSummary> {
  const today = businessDateOf(now, settings);
  const weekStart = weekStartOf(today, settings.weekStartDay);
  const weekEnd = addDays(weekStart, 6);
  const entries = await findWorkedEntries(executor, {
    locationId: actor.locationId,
    from: weekStart,
    to: weekEnd,
    employeeIds: [employeeId],
  });
  const secondsOf = (entry: (typeof entries)[number]) =>
    entry.status === "OPEN" ? workedSeconds(entry, entry.breaks, now) : entry.workedSeconds;
  const total = entries.reduce((sum, entry) => sum + secondsOf(entry), 0);
  const todaySeconds = entries
    .filter((entry) => entry.businessDate === today)
    .reduce((sum, entry) => sum + secondsOf(entry), 0);

  return {
    weekStart,
    weekEnd,
    workedSeconds: total,
    thresholdSeconds: settings.thresholdSeconds,
    state: overtimeState(total, settings.thresholdSeconds, {
      todaySeconds,
      thresholdSeconds: settings.dailyThresholdSeconds,
    }),
  };
}

/**
 * Phase 20 (policy 14, D12): what the periodic check notifies about at one location. On-clock
 * employees at or past the approaching-overtime line this work week, and OPEN entries from an
 * earlier business date (missed clock-outs). Read only.
 */
export async function findTimeClockSignals(executor: DatabaseExecutor, location: LocationRef, now: Date) {
  const settings = await loadClockSettings(executor, location);
  const today = businessDateOf(now, settings);
  const open = await executor
    .select({ id: timeEntries.id, employeeId: timeEntries.employeeId, businessDate: timeEntries.businessDate })
    .from(timeEntries)
    .where(and(eq(timeEntries.locationId, location.locationId), eq(timeEntries.status, "OPEN")));
  const approaching: { entryId: string; employeeId: string; weekStart: string; state: OvertimeState }[] = [];

  for (const entry of open.filter((row) => row.businessDate === today)) {
    const summary = await weekSummary(executor, location, settings, entry.employeeId, now);

    if (summary.state !== "NONE") {
      approaching.push({ entryId: entry.id, employeeId: entry.employeeId, weekStart: summary.weekStart, state: summary.state });
    }
  }

  return {
    today,
    approaching,
    missedClockOuts: open
      .filter((row) => row.businessDate < today)
      .map((row) => ({ entryId: row.id, employeeId: row.employeeId, businessDate: row.businessDate })),
  };
}

// ------------------------------------------------------------------ punches

export type ClockInResult = {
  entryId: string;
  businessDate: string;
  positionId: string;
  shiftAssignmentId: string | null;
  warnings: { unscheduled: boolean; overtime: OvertimeState };
};

async function lockOpenEntryFor(transaction: DatabaseTransaction, employeeId: string): Promise<EntryRow | undefined> {
  const [row] = await transaction
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, employeeId), eq(timeEntries.status, "OPEN")))
    .for("update");

  return row;
}

async function lockEntry(transaction: DatabaseTransaction, actor: Actor, entryId: string): Promise<EntryRow> {
  const [row] = await transaction
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.id, entryId),
        eq(timeEntries.organizationId, actor.organizationId),
        eq(timeEntries.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!row) {
    throw new NotFoundError("time entry");
  }

  return row;
}

async function employeeNumberOf(executor: DatabaseExecutor, employeeId: string): Promise<string> {
  const [row] = await executor
    .select({ number: employees.employeeNumber })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row?.number ?? "";
}

async function positionCodeOf(executor: DatabaseExecutor, positionId: string): Promise<string> {
  const [row] = await executor.select({ code: positions.code }).from(positions).where(eq(positions.id, positionId));

  return row?.code ?? "";
}

/**
 * Clock in (policies A4, A5, A11). `employeeId` is for manager punches only; a self punch
 * passes null and the employee comes from the login link.
 */
export async function clockIn(
  database: Database,
  actor: Actor,
  input: { employeeId: string | null; positionId: string | null; idempotencyKey: string },
): Promise<ClockInResult> {
  const managerPunch = input.employeeId !== null;

  assertPermission(actor, managerPunch ? "timeclock.manage" : "timeclock.punch");

  try {
    return await withTransaction(database, async (transaction) => {
      const employeeId = input.employeeId ?? (await resolveSelfEmployeeId(transaction, actor));
      const outcome = await runIdempotent(
        transaction,
        {
          organizationId: actor.organizationId,
          scope: CLOCK_IN_SCOPE,
          key: input.idempotencyKey,
          actorUserId: actor.userId,
          request: { employeeId, positionId: input.positionId, locationId: actor.locationId },
        },
        async (idempotencyRecordId) => {
          await lockEmployeesForScheduling(transaction, [employeeId]);

          const now = new Date();
          const settings = await loadClockSettings(transaction, actor);
          const businessDate = businessDateOf(now, settings);
          const { positionId } = await resolveEligiblePosition(
            transaction,
            actor,
            employeeId,
            businessDate,
            input.positionId,
          );

          await assertTipsNotFinalized(transaction, actor, [businessDate]);

          if (await lockOpenEntryFor(transaction, employeeId)) {
            throw new BusinessRuleError("ALREADY_CLOCKED_IN", "This employee is already on the clock.");
          }

          const shiftAssignmentId = matchShift(
            { at: now, positionId, locationId: actor.locationId },
            await findShiftCandidates(transaction, employeeId, actor.locationId, now),
          );
          const [entry] = await transaction
            .insert(timeEntries)
            .values({
              organizationId: actor.organizationId,
              locationId: actor.locationId,
              employeeId,
              positionId,
              shiftAssignmentId,
              businessDate,
              clockInAt: now,
              clockInRecordedAt: now,
              clockInSource: managerPunch ? "MANAGER" : "SELF",
              clockInByUserId: actor.userId,
              clockInIdempotencyRecordId: idempotencyRecordId,
            })
            .returning({ id: timeEntries.id });

          if (managerPunch) {
            await recordAudit(transaction, actor, {
              action: "timeclock.manager-clock-in",
              entityId: entry!.id,
              details: {
                employeeNumber: await employeeNumberOf(transaction, employeeId),
                positionCode: await positionCodeOf(transaction, positionId),
                clockInAt: now.toISOString(),
              },
            });
          }

          const week = await weekSummary(transaction, actor, settings, employeeId, now);

          return {
            entryId: entry!.id,
            businessDate,
            positionId,
            shiftAssignmentId,
            warnings: { unscheduled: shiftAssignmentId === null, overtime: week.state },
          };
        },
      );

      return outcome.response;
    });
  } catch (error) {
    if (isUniqueViolation(error) || isExclusionViolation(error)) {
      throw new BusinessRuleError("ALREADY_CLOCKED_IN", "This employee is already on the clock.");
    }

    throw error;
  }
}

export type ClockOutResult = { entryId: string; clockOutAt: string; workedSeconds: number };

/** Clock out (policies A6, A11). A self punch closes the caller's own OPEN entry. */
export async function clockOut(
  database: Database,
  actor: Actor,
  input: { entryId: string | null; expectedVersion: number | null; idempotencyKey: string },
): Promise<ClockOutResult> {
  const managerPunch = input.entryId !== null;

  assertPermission(actor, managerPunch ? "timeclock.manage" : "timeclock.punch");

  return withTransaction(database, async (transaction) => {
    const selfEmployeeId = managerPunch ? null : await resolveSelfEmployeeId(transaction, actor);
    const outcome = await runIdempotent(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: CLOCK_OUT_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { entryId: input.entryId, employeeId: selfEmployeeId, expectedVersion: input.expectedVersion },
      },
      async () => {
        const entry = managerPunch
          ? await lockEntry(transaction, actor, input.entryId!)
          : await lockOpenEntryFor(transaction, selfEmployeeId!);

        if (!entry || entry.status !== "OPEN" || entry.locationId !== actor.locationId) {
          throw new BusinessRuleError("NOT_CLOCKED_IN", "There is no open time entry to clock out of.");
        }

        if (input.expectedVersion !== null && entry.version !== input.expectedVersion) {
          throw new ConcurrencyError("time entry", entry.id);
        }

        await assertTipsNotFinalized(transaction, actor, [entry.businessDate]);

        const now = new Date();

        if (now.getTime() <= entry.clockInAt.getTime()) {
          throw new BusinessRuleError("CLOCK_OUT_TOO_SOON", "Wait a moment before clocking out.");
        }

        await transaction
          .update(timeEntryBreaks)
          .set({ endedAt: now, updatedAt: now })
          .where(
            and(
              eq(timeEntryBreaks.timeEntryId, entry.id),
              isNull(timeEntryBreaks.endedAt),
              isNull(timeEntryBreaks.removedAt),
            ),
          );
        await transaction
          .update(timeEntries)
          .set({
            status: "CLOSED",
            clockOutAt: now,
            clockOutRecordedAt: now,
            clockOutSource: managerPunch ? "MANAGER" : "SELF",
            clockOutByUserId: actor.userId,
            version: sql`${timeEntries.version} + 1`,
            updatedAt: now,
          })
          .where(eq(timeEntries.id, entry.id));

        if (managerPunch) {
          await recordAudit(transaction, actor, {
            action: "timeclock.manager-clock-out",
            entityId: entry.id,
            details: {
              employeeNumber: await employeeNumberOf(transaction, entry.employeeId),
              clockOutAt: now.toISOString(),
            },
          });
        }

        const breaks = (await findBreaks(transaction, [entry.id])).get(entry.id) ?? [];

        return {
          entryId: entry.id,
          clockOutAt: now.toISOString(),
          workedSeconds: workedSeconds({ clockInAt: entry.clockInAt, clockOutAt: now }, breaks),
        };
      },
    );

    return outcome.response;
  });
}

/** Start or end a break on the caller's own open entry (policy A3). */
export async function recordBreak(
  database: Database,
  actor: Actor,
  input: { action: "START" | "END"; paid: boolean; idempotencyKey: string },
): Promise<{ breakId: string }> {
  assertPermission(actor, "timeclock.punch");

  try {
    return await withTransaction(database, async (transaction) => {
      const employeeId = await resolveSelfEmployeeId(transaction, actor);
      const outcome = await runIdempotent(
        transaction,
        {
          organizationId: actor.organizationId,
          scope: BREAK_SCOPE,
          key: input.idempotencyKey,
          actorUserId: actor.userId,
          request: { employeeId, action: input.action, paid: input.action === "START" ? input.paid : null },
        },
        async () => {
          const entry = await lockOpenEntryFor(transaction, employeeId);

          if (!entry || entry.locationId !== actor.locationId) {
            throw new BusinessRuleError("NOT_CLOCKED_IN", "Clock in before taking a break.");
          }

          const now = new Date();
          const [open] = await transaction
            .select({ id: timeEntryBreaks.id })
            .from(timeEntryBreaks)
            .where(
              and(
                eq(timeEntryBreaks.timeEntryId, entry.id),
                isNull(timeEntryBreaks.endedAt),
                isNull(timeEntryBreaks.removedAt),
              ),
            );

          if (input.action === "START") {
            if (open) {
              throw new BusinessRuleError("ALREADY_ON_BREAK", "You're already on a break.");
            }

            const [row] = await transaction
              .insert(timeEntryBreaks)
              .values({ timeEntryId: entry.id, startedAt: now, paid: input.paid, recordedByUserId: actor.userId })
              .returning({ id: timeEntryBreaks.id });

            return { breakId: row!.id };
          }

          if (!open) {
            throw new BusinessRuleError("NOT_ON_BREAK", "You're not on a break.");
          }

          await transaction
            .update(timeEntryBreaks)
            .set({ endedAt: now, updatedAt: now })
            .where(eq(timeEntryBreaks.id, open.id));

          return { breakId: open.id };
        },
      );

      return outcome.response;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BusinessRuleError("ALREADY_ON_BREAK", "You're already on a break.");
    }

    throw error;
  }
}

// ------------------------------------------------------------------ adjustments and void

export type BreakChange =
  | { kind: "ADD"; startedAt: Date; endedAt: Date; paid: boolean }
  | { kind: "UPDATE"; id: string; startedAt: Date; endedAt: Date; paid: boolean }
  | { kind: "REMOVE"; id: string };

export type AdjustInput = {
  expectedVersion: number;
  reason: string;
  clockInAt?: Date;
  clockOutAt?: Date;
  positionId?: string;
  breaks?: BreakChange[];
};

function requireReason(reason: string): string {
  const text = reason.trim();

  if (text.length === 0 || text.length > 500) {
    throw new ValidationError("Enter a reason of up to 500 characters.");
  }

  if (/[0-9]{13,}/.test(text)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  return text;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Policy A8: a manager's correction, with the before and after values kept. */
export async function adjustEntry(database: Database, actor: Actor, entryId: string, input: AdjustInput) {
  assertPermission(actor, "timeclock.manage");

  const reason = requireReason(input.reason);

  try {
    return await withTransaction(database, async (transaction) => {
      const entry = await lockEntry(transaction, actor, entryId);

      if (entry.version !== input.expectedVersion) {
        throw new ConcurrencyError("time entry", entry.id);
      }

      if (entry.status === "VOIDED") {
        throw new BusinessRuleError("TIME_ENTRY_VOIDED", "A voided time entry can't be adjusted.");
      }

      await lockEmployeesForScheduling(transaction, [entry.employeeId]);

      const now = new Date();
      const settings = await loadClockSettings(transaction, actor);
      const clockInAt = input.clockInAt ?? entry.clockInAt;
      const clockOutAt = input.clockOutAt ?? entry.clockOutAt;

      if (clockInAt > now || (clockOutAt && clockOutAt > now)) {
        throw new BusinessRuleError("TIME_IN_FUTURE", "Corrected times can't be in the future.");
      }

      if (clockOutAt && clockOutAt <= clockInAt) {
        throw new BusinessRuleError("CLOCK_OUT_BEFORE_IN", "The clock-out must be after the clock-in.");
      }

      const businessDate = businessDateOf(clockInAt, settings);

      await assertTipsNotFinalized(transaction, actor, [entry.businessDate, businessDate]);

      const positionId = input.positionId ?? entry.positionId;

      if (input.positionId !== undefined || businessDate !== entry.businessDate) {
        await resolveEligiblePosition(transaction, actor, entry.employeeId, businessDate, positionId);
      }

      const changes: Record<string, { before: unknown; after: unknown }> = {};

      if (clockInAt.getTime() !== entry.clockInAt.getTime()) {
        changes.clockInAt = { before: iso(entry.clockInAt), after: iso(clockInAt) };
      }

      if ((clockOutAt?.getTime() ?? null) !== (entry.clockOutAt?.getTime() ?? null)) {
        changes.clockOutAt = { before: iso(entry.clockOutAt), after: iso(clockOutAt) };
      }

      if (positionId !== entry.positionId) {
        changes.positionId = { before: entry.positionId, after: positionId };
      }

      if (businessDate !== entry.businessDate) {
        changes.businessDate = { before: entry.businessDate, after: businessDate };
      }

      const rematch = changes.clockInAt !== undefined || changes.positionId !== undefined;
      const shiftAssignmentId = rematch
        ? matchShift(
            { at: clockInAt, positionId, locationId: actor.locationId },
            await findShiftCandidates(transaction, entry.employeeId, actor.locationId, clockInAt),
          )
        : entry.shiftAssignmentId;

      if (shiftAssignmentId !== entry.shiftAssignmentId) {
        changes.shiftAssignmentId = { before: entry.shiftAssignmentId, after: shiftAssignmentId };
      }

      const breakChanges = await applyBreakChanges(transaction, actor, entry.id, input.breaks ?? [], now);

      if (breakChanges.length > 0) {
        changes.breaks = { before: breakChanges.map((change) => change.before), after: breakChanges.map((change) => change.after) };
      }

      const closing = entry.status === "OPEN" && clockOutAt !== null;

      if (closing) {
        // A missed clock-out set afterwards: no punch happened, so nothing is "recorded".
        await transaction
          .update(timeEntryBreaks)
          .set({ endedAt: clockOutAt, updatedAt: now })
          .where(
            and(
              eq(timeEntryBreaks.timeEntryId, entry.id),
              isNull(timeEntryBreaks.endedAt),
              isNull(timeEntryBreaks.removedAt),
            ),
          );
      }

      if (Object.keys(changes).length === 0) {
        throw new BusinessRuleError("NOTHING_TO_ADJUST", "Change at least one value.");
      }

      const [updated] = await transaction
        .update(timeEntries)
        .set({
          clockInAt,
          clockOutAt,
          positionId,
          businessDate,
          shiftAssignmentId,
          ...(closing
            ? { status: "CLOSED", clockOutSource: "ADJUSTMENT", clockOutByUserId: actor.userId }
            : {}),
          version: sql`${timeEntries.version} + 1`,
          updatedAt: now,
        })
        .where(eq(timeEntries.id, entry.id))
        .returning({ id: timeEntries.id, version: timeEntries.version });

      await transaction.insert(timeEntryAdjustments).values({
        timeEntryId: entry.id,
        adjustedByUserId: actor.userId,
        adjustedAt: now,
        reason,
        changes,
      });

      await recordAudit(transaction, actor, {
        action: "timeclock.entry-adjusted",
        entityId: entry.id,
        details: {
          employeeNumber: await employeeNumberOf(transaction, entry.employeeId),
          businessDate,
          changedFields: Object.keys(changes),
          reason,
        },
      });

      return updated!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError("TIME_ENTRY_OVERLAP", "That would overlap another time entry for this employee.");
    }

    throw error;
  }
}

type BreakRecord = { id: string; startedAt: string; endedAt: string | null; paid: boolean } | null;

async function applyBreakChanges(
  transaction: DatabaseTransaction,
  actor: Actor,
  entryId: string,
  changes: readonly BreakChange[],
  now: Date,
): Promise<{ before: BreakRecord; after: BreakRecord }[]> {
  const history: { before: BreakRecord; after: BreakRecord }[] = [];
  const current = await transaction
    .select()
    .from(timeEntryBreaks)
    .where(and(eq(timeEntryBreaks.timeEntryId, entryId), isNull(timeEntryBreaks.removedAt)));
  const record = (row: { id: string; startedAt: Date; endedAt: Date | null; paid: boolean }): BreakRecord => ({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    paid: row.paid,
  });

  for (const change of changes) {
    if (change.kind !== "REMOVE" && (change.endedAt <= change.startedAt || change.endedAt > now)) {
      throw new BusinessRuleError("INVALID_BREAK", "A break must end after it starts, and not in the future.");
    }

    if (change.kind === "ADD") {
      const [row] = await transaction
        .insert(timeEntryBreaks)
        .values({
          timeEntryId: entryId,
          startedAt: change.startedAt,
          endedAt: change.endedAt,
          paid: change.paid,
          recordedByUserId: actor.userId,
        })
        .returning();

      history.push({ before: null, after: record(row!) });
      continue;
    }

    const existing = current.find((row) => row.id === change.id);

    if (!existing) {
      throw new NotFoundError("break");
    }

    if (change.kind === "REMOVE") {
      await transaction
        .update(timeEntryBreaks)
        .set({ removedAt: now, removedByUserId: actor.userId, updatedAt: now })
        .where(eq(timeEntryBreaks.id, existing.id));
      history.push({ before: record(existing), after: null });
      continue;
    }

    const [row] = await transaction
      .update(timeEntryBreaks)
      .set({ startedAt: change.startedAt, endedAt: change.endedAt, paid: change.paid, updatedAt: now })
      .where(eq(timeEntryBreaks.id, existing.id))
      .returning();

    history.push({ before: record(existing), after: record(row!) });
  }

  return history;
}

/** Policy A9: void an entry made by mistake. It stays, as VOIDED, and counts nowhere. */
export async function voidEntry(
  database: Database,
  actor: Actor,
  entryId: string,
  input: { expectedVersion: number; reason: string },
) {
  assertPermission(actor, "timeclock.manage");

  const reason = requireReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const entry = await lockEntry(transaction, actor, entryId);

    if (entry.version !== input.expectedVersion) {
      throw new ConcurrencyError("time entry", entry.id);
    }

    if (entry.status === "VOIDED") {
      throw new BusinessRuleError("TIME_ENTRY_VOIDED", "This time entry is already voided.");
    }

    await assertTipsNotFinalized(transaction, actor, [entry.businessDate]);

    const now = new Date();
    const [updated] = await transaction
      .update(timeEntries)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: actor.userId,
        voidReason: reason,
        version: sql`${timeEntries.version} + 1`,
        updatedAt: now,
      })
      .where(eq(timeEntries.id, entry.id))
      .returning({ id: timeEntries.id, version: timeEntries.version });

    await recordAudit(transaction, actor, {
      action: "timeclock.entry-voided",
      entityId: entry.id,
      details: {
        employeeNumber: await employeeNumberOf(transaction, entry.employeeId),
        businessDate: entry.businessDate,
        reason,
      },
    });

    return updated!;
  });
}

// ------------------------------------------------------------------ views

export type EntryView = {
  id: string;
  employeeId: string;
  positionId: string;
  positionName: string;
  businessDate: string;
  status: "OPEN" | "CLOSED";
  clockInAt: string;
  clockOutAt: string | null;
  scheduled: boolean;
  adjusted: boolean;
  workedSeconds: number;
  breaks: { id: string; startedAt: string; endedAt: string | null; paid: boolean }[];
  version: number;
};

async function toViews(executor: DatabaseExecutor, entries: readonly WorkedEntry[], now: Date): Promise<EntryView[]> {
  if (entries.length === 0) {
    return [];
  }

  const positionRows = await executor
    .select({ id: positions.id, name: positions.name })
    .from(positions)
    .where(inArray(positions.id, [...new Set(entries.map((entry) => entry.positionId))]));
  const versions = await executor
    .select({ id: timeEntries.id, version: timeEntries.version })
    .from(timeEntries)
    .where(inArray(timeEntries.id, entries.map((entry) => entry.id)));
  const positionName = new Map(positionRows.map((row) => [row.id, row.name]));
  const version = new Map(versions.map((row) => [row.id, row.version]));

  return entries.map((entry) => ({
    id: entry.id,
    employeeId: entry.employeeId,
    positionId: entry.positionId,
    positionName: positionName.get(entry.positionId) ?? "",
    businessDate: entry.businessDate,
    status: entry.status,
    clockInAt: entry.clockInAt.toISOString(),
    clockOutAt: iso(entry.clockOutAt),
    scheduled: entry.shiftAssignmentId !== null,
    adjusted: entry.adjusted,
    workedSeconds: entry.status === "OPEN" ? workedSeconds(entry, entry.breaks, now) : entry.workedSeconds,
    breaks: entry.breaks.map((span) => ({
      id: span.id,
      startedAt: span.startedAt.toISOString(),
      endedAt: iso(span.endedAt),
      paid: span.paid,
    })),
    version: version.get(entry.id) ?? 1,
  }));
}

/** `/my-time`: the caller's own week, open entry and overtime state. */
export async function getMyTime(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "timeclock.punch");

  const now = new Date();
  const [linked] = await executor
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, actor.userId), eq(employees.organizationId, actor.organizationId)));

  if (!linked) {
    return { linked: false as const };
  }

  const settings = await loadClockSettings(executor, actor);
  const businessDate = businessDateOf(now, settings);
  const week = await weekSummary(executor, actor, settings, linked.id, now);
  const entries = await findWorkedEntries(executor, {
    locationId: actor.locationId,
    from: week.weekStart,
    to: week.weekEnd,
    employeeIds: [linked.id],
  });
  const [facts] = await findSchedulingFacts(executor, { organizationId: actor.organizationId, employeeIds: [linked.id] });
  const held = facts ? heldPositionIds(facts, actor.locationId, businessDate) : [];
  const heldRows =
    held.length === 0
      ? []
      : await executor
          .select({ id: positions.id, name: positions.name })
          .from(positions)
          .where(inArray(positions.id, held))
          .orderBy(asc(positions.name));
  const [openAnywhere] = await executor
    .select({ id: timeEntries.id, locationId: timeEntries.locationId })
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, linked.id), eq(timeEntries.status, "OPEN")));
  const views = await toViews(executor, entries, now);

  return {
    linked: true as const,
    employeeId: linked.id,
    timeZone: settings.timeZone,
    businessDate,
    positions: heldRows,
    openEntry: views.find((view) => view.status === "OPEN") ?? null,
    openElsewhere: openAnywhere !== undefined && openAnywhere.locationId !== actor.locationId,
    week: { ...week, entries: views },
  };
}

/** `/scheduling/time-clock`: everyone at the location (policy A1: needs `timeclock.view`). */
export async function getTimeClockBoard(executor: DatabaseExecutor, actor: Actor, input: { businessDate?: string }) {
  assertPermission(actor, "timeclock.view");

  const now = new Date();
  const settings = await loadClockSettings(executor, actor);
  const today = businessDateOf(now, settings);
  const date = input.businessDate ?? today;
  const staff = (await findSchedulingFacts(executor, { organizationId: actor.organizationId, locationId: actor.locationId }))
    .filter((facts) => facts.employmentStatus === "ACTIVE")
    .filter((facts) => facts.locations.some((location) => location.locationId === actor.locationId && coversDate(location, today)));
  const openRows = await executor
    .select({ id: timeEntries.id, businessDate: timeEntries.businessDate })
    .from(timeEntries)
    .where(and(eq(timeEntries.locationId, actor.locationId), eq(timeEntries.status, "OPEN")));
  const openDates = [...new Set(openRows.map((row) => row.businessDate))];
  const openEntries = (
    await Promise.all(
      openDates.map((openDate) =>
        findWorkedEntries(executor, { locationId: actor.locationId, from: openDate, to: openDate }),
      ),
    )
  )
    .flat()
    .filter((entry) => entry.status === "OPEN");
  const dayEntries = await findWorkedEntries(executor, { locationId: actor.locationId, from: date, to: date });
  const names = new Map(
    (await findSchedulingFacts(executor, {
      organizationId: actor.organizationId,
      employeeIds: [...new Set([...openEntries, ...dayEntries].map((entry) => entry.employeeId))],
    })).map((facts) => [facts.id, { number: facts.employeeNumber, name: facts.displayName }]),
  );
  const onClock = await Promise.all(
    openEntries
      .filter((entry) => entry.businessDate === today)
      .map(async (entry) => ({
        ...(await toViews(executor, [entry], now))[0]!,
        employee: names.get(entry.employeeId) ?? null,
        onBreak: entry.breaks.some((span) => span.endedAt === null),
        week: await weekSummary(executor, actor, settings, entry.employeeId, now),
      })),
  );
  const missed = (await toViews(executor, openEntries.filter((entry) => entry.businessDate < today), now)).map((view) => ({
    ...view,
    employee: names.get(view.employeeId) ?? null,
  }));
  const day = (await toViews(executor, dayEntries, now)).map((view) => ({
    ...view,
    employee: names.get(view.employeeId) ?? null,
  }));

  return {
    timeZone: settings.timeZone,
    today,
    businessDate: date,
    canManage: actorHolds(actor, "timeclock.manage"),
    onClock,
    missedClockOuts: missed,
    entries: day,
    staff: await staffWithPositions(executor, actor, staff, today),
  };
}

async function staffWithPositions(
  executor: DatabaseExecutor,
  actor: Actor,
  staff: readonly SchedulingEmployeeFacts[],
  date: string,
) {
  const held = new Map(staff.map((facts) => [facts.id, heldPositionIds(facts, actor.locationId, date)]));
  const ids = [...new Set([...held.values()].flat())];
  const rows =
    ids.length === 0
      ? []
      : await executor
          .select({ id: positions.id, name: positions.name })
          .from(positions)
          .where(inArray(positions.id, ids))
          .orderBy(asc(positions.name));

  return staff
    .map((facts) => ({
      id: facts.id,
      number: facts.employeeNumber,
      name: facts.displayName,
      positions: rows.filter((row) => held.get(facts.id)!.includes(row.id)),
    }))
    .filter((member) => member.positions.length > 0);
}

/** Adjustment history for one entry (manager view). */
export async function listAdjustments(executor: DatabaseExecutor, actor: Actor, entryId: string) {
  assertPermission(actor, "timeclock.view");

  const [entry] = await executor
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.locationId, actor.locationId)));

  if (!entry) {
    throw new NotFoundError("time entry");
  }

  return executor
    .select({
      id: timeEntryAdjustments.id,
      adjustedAt: timeEntryAdjustments.adjustedAt,
      reason: timeEntryAdjustments.reason,
      changes: timeEntryAdjustments.changes,
    })
    .from(timeEntryAdjustments)
    .where(eq(timeEntryAdjustments.timeEntryId, entryId))
    .orderBy(asc(timeEntryAdjustments.adjustedAt));
}

