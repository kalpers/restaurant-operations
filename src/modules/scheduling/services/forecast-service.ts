import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import { shifts, staffingTemplateRequirements } from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findPositionInOrganization } from "@/modules/employees/repositories/reference-repository";
import { getDemandHistory } from "@/modules/orders/queries/demand-history";
import { getBookedCovers } from "@/modules/reservations/queries/booked-demand";
import { compareDecimals } from "@/shared/decimal/decimal";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf, type BusinessDateSettings } from "@/shared/time/business-date-service";
import { addDays, localTimeOf } from "@/shared/time/zoned-time";

import {
  deactivateExcludedDateRow,
  findExcludedDates,
  findLocationClockSettings,
  findRatio,
  findRatios,
  insertExcludedDate,
  insertRatio,
  insertStoredForecast,
  updateRatioRow,
  type RatioRow,
} from "../repositories/forecast-repository";
import { findActivePositions, findRulesRow } from "../repositories/config-repository";
import {
  findActiveAssignmentsForPeriod,
  findPeriodShifts,
  updatePeriodRow,
  updateShiftRow,
  type PeriodRow,
  type PeriodShiftRow,
} from "../repositories/schedule-repository";
import {
  DEMAND_MEASURES,
  MAXIMUM_HISTORY_WEEKS,
  forecastDate,
  hoursTouched,
  selectHistoryDates,
  suggestShiftCount,
  type DateForecast,
  type DemandMeasure,
  type HistoryCounts,
  type ShiftSuggestion,
  type StaffingRatio,
} from "../rules/demand-forecast";
import { DEFAULT_RULE_ROW } from "../rules/schedule-rules";
import { assertPermission, lockEditableDraft, requireVisiblePeriod } from "./access";

// Phase 24 demand forecast service (policies 3-15). The forecast is worked out on read;
// it is stored only when a manager uses it to size shifts.

export type ForecastContext = {
  clock: BusinessDateSettings;
  today: string;
  settings: { lookbackWeeks: number; minimumSamples: number };
  ratios: RatioRow[];
  excludedDates: string[];
  /** Business dates forecast, oldest first (today or later only). */
  dates: string[];
  forecasts: Map<string, DateForecast>;
};

async function loadClock(executor: DatabaseExecutor, locationId: string): Promise<BusinessDateSettings> {
  const clock = await findLocationClockSettings(executor, locationId);

  if (!clock) {
    throw new NotFoundError("location");
  }

  return clock;
}

/**
 * Policies 3-4: the forecast for a period's dates (and the day after its end, which its
 * late shifts can reach past the cutoff), from today's business date onward.
 */
export async function buildForecastContext(
  executor: DatabaseExecutor,
  actor: Actor,
  period: Pick<PeriodRow, "startDate" | "endDate">,
  now = new Date(),
): Promise<ForecastContext> {
  const clock = await loadClock(executor, actor.locationId);
  const today = businessDateOf(now, clock);
  const rules = (await findRulesRow(executor, actor.locationId)) ?? DEFAULT_RULE_ROW;
  const settings = {
    lookbackWeeks: rules.forecastLookbackWeeks,
    minimumSamples: rules.forecastMinimumSamples,
  };
  const [ratios, excludedRows] = await Promise.all([
    findRatios(executor, actor.locationId, true),
    findExcludedDates(executor, actor.locationId),
  ]);
  const excludedDates = excludedRows.map((row) => row.excludedDate);
  const dates: string[] = [];

  for (let date = period.startDate; date <= addDays(period.endDate, 1); date = addDays(date, 1)) {
    if (date >= today) {
      dates.push(date);
    }
  }

  const forecasts = new Map<string, DateForecast>();

  if (dates.length === 0) {
    return { clock, today, settings, ratios, excludedDates, dates, forecasts };
  }

  const historyTo = addDays(dates[dates.length - 1]!, -7) < today
    ? addDays(dates[dates.length - 1]!, -7)
    : addDays(today, -1);
  const historyFrom = addDays(dates[0]!, -7 * MAXIMUM_HISTORY_WEEKS);
  const [history, booked] = await Promise.all([
    getDemandHistory(executor, {
      locationId: actor.locationId,
      timeZone: clock.timeZone,
      fromDate: historyFrom,
      toDate: historyTo,
    }),
    getBookedCovers(executor, {
      locationId: actor.locationId,
      timeZone: clock.timeZone,
      fromDate: dates[0]!,
      toDate: dates[dates.length - 1]!,
    }),
  ]);
  const historyByDate = new Map<string, Map<number, HistoryCounts>>();

  for (const row of history.hours) {
    const byHour = historyByDate.get(row.businessDate) ?? new Map<number, HistoryCounts>();

    byHour.set(row.hour, {
      DINING_COVERS: row.diningCovers,
      BAR_CHECKS: row.barChecks,
      TAKEOUT_CHECKS: row.takeoutChecks,
      ALL_CHECKS: row.allChecks,
    });
    historyByDate.set(row.businessDate, byHour);
  }

  const bookedByDate = new Map<string, Map<number, number>>();

  for (const row of booked) {
    const byHour = bookedByDate.get(row.businessDate) ?? new Map<number, number>();

    byHour.set(row.hour, row.covers);
    bookedByDate.set(row.businessDate, byHour);
  }

  const openDates = new Set(history.openDates);
  const excluded = new Set(excludedDates);

  for (const date of dates) {
    const sampleDates = selectHistoryDates({
      targetDate: date,
      today,
      openDates,
      excludedDates: excluded,
      lookbackWeeks: settings.lookbackWeeks,
    });

    forecasts.set(
      date,
      forecastDate({
        targetDate: date,
        sampleDates,
        settings,
        history: historyByDate,
        booked: bookedByDate.get(date) ?? new Map(),
      }),
    );
  }

  return { clock, today, settings, ratios, excludedDates, dates, forecasts };
}

function ratioFor(context: ForecastContext, positionId: string): StaffingRatio | null {
  const row = context.ratios.find((ratio) => ratio.positionId === positionId);

  return row
    ? {
        measure: row.measure as DemandMeasure,
        unitsPerEmployeeHour: row.unitsPerEmployeeHour,
        minimumEmployees: row.minimumEmployees,
        maximumEmployees: row.maximumEmployees,
      }
    : null;
}

/** Policies 8-9: a shift window's suggestion. Dates already past are never sized. */
export function suggestForWindow(
  context: ForecastContext,
  input: { positionId: string; positionName: string; startAt: Date; endAt: Date },
): ShiftSuggestion {
  const window = hoursTouched(input.startAt, input.endAt, context.clock);

  if (window.length === 0 || window[0]!.businessDate < context.today) {
    return {
      suggestedCount: null,
      reason: "STARTED",
      measure: null,
      peak: null,
      sampleDates: [],
      unitsPerEmployeeHour: null,
      rawCount: null,
      explanation: "This shift's date has passed, so it isn't sized from the forecast.",
    };
  }

  return suggestShiftCount({
    window,
    ratio: ratioFor(context, input.positionId),
    forecasts: context.forecasts,
    positionName: input.positionName,
  });
}

/** Policy 11: stores the forecast as used, with the ratios and settings behind it. */
export async function storeForecast(
  transaction: DatabaseTransaction,
  actor: Actor,
  periodId: string,
  context: ForecastContext,
): Promise<string> {
  const hours = [];

  for (const forecast of context.forecasts.values()) {
    for (const hour of forecast.hours) {
      if (hour.forecastValue === null && hour.bookedValue === 0) {
        continue;
      }

      if (hour.forecastValue !== null && compareDecimals(hour.forecastValue, "0") === 0 && hour.bookedValue === 0) {
        continue;
      }

      hours.push({
        businessDate: forecast.businessDate,
        hour: hour.hour,
        measure: hour.measure,
        historyValue: hour.historyValue,
        bookedValue: hour.bookedValue,
        forecastValue: hour.forecastValue,
        sampleCount: forecast.sampleDates.length,
      });
    }
  }

  return insertStoredForecast(transaction, {
    forecast: {
      locationId: actor.locationId,
      schedulePeriodId: periodId,
      createdByUserId: actor.userId,
      lookbackWeeks: context.settings.lookbackWeeks,
      minimumSamples: context.settings.minimumSamples,
      method: {
        today: context.today,
        timeZone: context.clock.timeZone,
        businessDayCutoff: context.clock.businessDayCutoff,
        weights: "linear, newest highest",
        ratios: context.ratios.map((ratio) => ({
          ratioId: ratio.id,
          positionId: ratio.positionId,
          measure: ratio.measure,
          unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
          minimumEmployees: ratio.minimumEmployees,
          maximumEmployees: ratio.maximumEmployees,
          version: ratio.version,
        })),
        excludedDates: context.excludedDates,
      },
    },
    dates: [...context.forecasts.values()].map((forecast) => ({
      businessDate: forecast.businessDate,
      status: forecast.status,
      sampleDates: forecast.sampleDates,
    })),
    hours,
  });
}

async function templateCounts(executor: DatabaseExecutor, requirementIds: readonly string[]) {
  if (requirementIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await executor
    .select({ id: staffingTemplateRequirements.id, count: staffingTemplateRequirements.requiredEmployeeCount })
    .from(staffingTemplateRequirements)
    .where(inArray(staffingTemplateRequirements.id, [...new Set(requirementIds)]));

  return new Map(rows.map((row) => [row.id, row.count]));
}

type ShiftForecastLine = {
  shiftId: string;
  shiftDate: string;
  positionName: string;
  restaurantAreaName: string | null;
  startTime: string;
  endTime: string;
  fromTemplate: boolean;
  templateCount: number | null;
  currentCount: number;
  assignedCount: number;
  suggestedCount: number | null;
  /** What "Use suggestion" would set: the suggestion, never below the assigned count. */
  applyCount: number | null;
  reason: ShiftSuggestion["reason"] | "NOT_FROM_TEMPLATE";
  explanation: string;
  sizedByForecastId: string | null;
  version: number;
};

function shiftLines(
  context: ForecastContext,
  periodShifts: readonly PeriodShiftRow[],
  assignedCounts: ReadonlyMap<string, number>,
  counts: ReadonlyMap<string, number>,
): ShiftForecastLine[] {
  return periodShifts.map((shift) => {
    const assignedCount = assignedCounts.get(shift.id) ?? 0;
    const base = {
      shiftId: shift.id,
      shiftDate: shift.shiftDate,
      positionName: shift.positionName,
      restaurantAreaName: shift.restaurantAreaName,
      startTime: localTimeOf(shift.startAt, context.clock.timeZone),
      endTime: localTimeOf(shift.endAt, context.clock.timeZone),
      fromTemplate: shift.sourceRequirementId !== null,
      templateCount:
        shift.templateEmployeeCount ??
        (shift.sourceRequirementId ? (counts.get(shift.sourceRequirementId) ?? null) : null),
      currentCount: shift.requiredEmployeeCount,
      assignedCount,
      sizedByForecastId: shift.demandForecastId,
      version: shift.version,
    };

    if (!shift.sourceRequirementId) {
      return {
        ...base,
        suggestedCount: null,
        applyCount: null,
        reason: "NOT_FROM_TEMPLATE" as const,
        explanation: "Added by hand, not from a template, so the forecast never changes it.",
      };
    }

    const suggestion = suggestForWindow(context, shift);

    return {
      ...base,
      suggestedCount: suggestion.suggestedCount,
      applyCount:
        suggestion.suggestedCount === null ? null : Math.max(suggestion.suggestedCount, assignedCount),
      reason: suggestion.reason,
      explanation: suggestion.explanation,
    };
  });
}

/** Policy 10: the forecast preview for a period. Stores nothing. */
export async function getPeriodForecast(
  executor: DatabaseExecutor,
  actor: Actor,
  periodId: string,
) {
  assertPermission(actor, "schedule.edit");

  const period = await requireVisiblePeriod(executor, actor, periodId);
  const context = await buildForecastContext(executor, actor, period);
  const [periodShifts, assignments] = await Promise.all([
    findPeriodShifts(executor, periodId),
    findActiveAssignmentsForPeriod(executor, periodId),
  ]);
  const assignedCounts = new Map<string, number>();

  for (const assignment of assignments) {
    assignedCounts.set(assignment.shiftId, (assignedCounts.get(assignment.shiftId) ?? 0) + 1);
  }

  const counts = await templateCounts(
    executor,
    periodShifts.flatMap((shift) => (shift.sourceRequirementId ? [shift.sourceRequirementId] : [])),
  );
  const cutoffHour = Number(context.clock.businessDayCutoff.slice(0, 2));
  const hourOrder = Array.from({ length: 24 }, (_, index) => (cutoffHour + index) % 24);

  return {
    period: { id: period.id, status: period.status, version: period.version, startDate: period.startDate, endDate: period.endDate },
    today: context.today,
    settings: context.settings,
    excludedDates: context.excludedDates,
    ratios: context.ratios.map((ratio) => ({
      positionName: ratio.positionName,
      measure: ratio.measure,
      unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
      minimumEmployees: ratio.minimumEmployees,
      maximumEmployees: ratio.maximumEmployees,
    })),
    dates: context.dates
      .filter((date) => date <= period.endDate)
      .map((date) => {
        const forecast = context.forecasts.get(date)!;

        return {
          businessDate: date,
          status: forecast.status,
          sampleDates: forecast.sampleDates,
          hours: hourOrder.map((hour) => {
            const values = Object.fromEntries(
              DEMAND_MEASURES.map((measure) => {
                const entry = forecast.hours.find((row) => row.hour === hour && row.measure === measure)!;

                return [measure, { history: entry.historyValue, booked: entry.bookedValue, forecast: entry.forecastValue }];
              }),
            ) as Record<DemandMeasure, { history: string | null; booked: number; forecast: string | null }>;

            return { hour, values };
          }),
        };
      }),
    shifts: shiftLines(context, periodShifts, assignedCounts, counts),
  };
}

/**
 * Policy 13: sets the listed (or all) template shifts of a DRAFT period to their
 * suggestion, never below their assigned count, after storing the forecast used.
 */
export async function applyForecastSuggestions(
  database: Database,
  actor: Actor,
  periodId: string,
  input: { expectedPeriodVersion: number; shiftIds?: string[] | null },
) {
  assertPermission(actor, "schedule.edit");

  return withTransaction(database, async (transaction) => {
    const period = await lockEditableDraft(transaction, actor, periodId, input.expectedPeriodVersion);
    const context = await buildForecastContext(transaction, actor, period);
    const [periodShifts, assignments] = await Promise.all([
      findPeriodShifts(transaction, periodId),
      findActiveAssignmentsForPeriod(transaction, periodId),
    ]);
    const assignedCounts = new Map<string, number>();

    for (const assignment of assignments) {
      assignedCounts.set(assignment.shiftId, (assignedCounts.get(assignment.shiftId) ?? 0) + 1);
    }

    const wanted = input.shiftIds ? new Set(input.shiftIds) : null;

    if (wanted) {
      const known = new Set(periodShifts.map((shift) => shift.id));

      for (const shiftId of wanted) {
        if (!known.has(shiftId)) {
          throw new NotFoundError("shift");
        }
      }
    }

    const counts = await templateCounts(
      transaction,
      periodShifts.flatMap((shift) => (shift.sourceRequirementId ? [shift.sourceRequirementId] : [])),
    );
    const lines = shiftLines(context, periodShifts, assignedCounts, counts).filter(
      (line) => !wanted || wanted.has(line.shiftId),
    );
    const toApply = lines.filter((line) => line.applyCount !== null);
    const skipped = lines
      .filter((line) => line.applyCount === null)
      .map((line) => ({ shiftId: line.shiftId, reason: line.reason, explanation: line.explanation }));

    if (toApply.length === 0) {
      return { updated: 0, skipped, forecastId: null, periodVersion: period.version };
    }

    const forecastId = await storeForecast(transaction, actor, periodId, context);

    for (const line of toApply) {
      assertVersionMatched(
        await updateShiftRow(transaction, line.shiftId, line.version, {
          requiredEmployeeCount: line.applyCount!,
          demandForecastId: forecastId,
          forecastSuggestedCount: line.suggestedCount!,
          templateEmployeeCount: line.templateCount,
          updatedAt: new Date(),
        }),
        { type: "shift", id: line.shiftId },
      );
    }

    const updatedPeriod = await updatePeriodRow(transaction, periodId);

    await recordAudit(transaction, actor, {
      action: "scheduling.forecast-applied",
      entityId: forecastId,
      after: {
        schedulePeriodId: periodId,
        mode: "SUGGESTIONS",
        sizedShiftCount: toApply.length,
        dateCount: context.forecasts.size,
      },
    });

    return { updated: toApply.length, skipped, forecastId, periodVersion: updatedPeriod.version };
  });
}

// ------------------------------------------------------------------ ratios and dates

/** Policies 6-7: what the Staffing page shows. */
export async function getForecastSettings(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.rules.manage");

  const [ratios, excludedDates, positions] = await Promise.all([
    findRatios(executor, actor.locationId),
    findExcludedDates(executor, actor.locationId),
    findActivePositions(executor, actor.organizationId),
  ]);

  return { ratios, excludedDates, positions };
}

export type RatioInput = {
  positionId: string;
  measure: DemandMeasure;
  unitsPerEmployeeHour: string;
  minimumEmployees: number;
  maximumEmployees: number;
};

function assertRatio(input: RatioInput): void {
  if (
    !/^\d{1,6}(\.\d{1,2})?$/.test(input.unitsPerEmployeeHour) ||
    compareDecimals(input.unitsPerEmployeeHour, "0") <= 0
  ) {
    throw new ValidationError("Enter how much one person handles in an hour, above 0 with at most two decimals.");
  }

  if (input.maximumEmployees < 1 || input.minimumEmployees < 0 || input.maximumEmployees < input.minimumEmployees) {
    throw new ValidationError("The maximum must be at least 1 and not below the minimum.");
  }
}

function ratioAudit(row: {
  positionId: string;
  measure: string;
  unitsPerEmployeeHour: string;
  minimumEmployees: number;
  maximumEmployees: number;
  active: boolean;
}) {
  return {
    positionId: row.positionId,
    measure: row.measure,
    unitsPerEmployeeHour: row.unitsPerEmployeeHour,
    minimumEmployees: row.minimumEmployees,
    maximumEmployees: row.maximumEmployees,
    active: row.active,
  };
}

/** Policy 7: a new ratio. One active ratio per position at a location. */
export async function createRatio(database: Database, actor: Actor, input: RatioInput) {
  assertPermission(actor, "schedule.rules.manage");
  assertRatio(input);

  const position = await findPositionInOrganization(database, input.positionId, actor.organizationId);

  if (!position) {
    throw new NotFoundError("position");
  }

  try {
    return await withTransaction(database, async (transaction) => {
      const row = await insertRatio(transaction, { ...input, locationId: actor.locationId });

      await recordAudit(transaction, actor, {
        action: "scheduling.staffing-ratio-saved",
        entityId: row.id,
        after: ratioAudit(row),
      });

      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "STAFFING_RATIO_EXISTS",
        "This position already has a staffing ratio. Change that one instead.",
      );
    }

    throw error;
  }
}

/** Policy 7: changes a ratio, or deactivates or reactivates it. Version checked. */
export async function updateRatio(
  database: Database,
  actor: Actor,
  ratioId: string,
  input: Omit<RatioInput, "positionId"> & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "schedule.rules.manage");
  assertRatio({ ...input, positionId: "" });

  try {
    return await withTransaction(database, async (transaction) => {
      const existing = await findRatio(transaction, ratioId, actor.locationId);

      if (!existing) {
        throw new NotFoundError("staffing ratio");
      }

      const [row] = await updateRatioRow(
        transaction,
        { id: ratioId, locationId: actor.locationId, expectedVersion: input.expectedVersion },
        {
          measure: input.measure,
          unitsPerEmployeeHour: input.unitsPerEmployeeHour,
          minimumEmployees: input.minimumEmployees,
          maximumEmployees: input.maximumEmployees,
          active: input.active,
        },
      );

      if (!row) {
        throw new ConcurrencyError("staffing ratio", ratioId);
      }

      await recordAudit(transaction, actor, {
        action: "scheduling.staffing-ratio-saved",
        entityId: ratioId,
        before: ratioAudit(existing),
        after: ratioAudit(row),
      });

      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "STAFFING_RATIO_EXISTS",
        "This position already has an active staffing ratio.",
      );
    }

    throw error;
  }
}

/** Policy 6: keeps a business date out of forecast history. */
export async function addExcludedDate(
  database: Database,
  actor: Actor,
  input: { excludedDate: string; reason: string },
) {
  assertPermission(actor, "schedule.rules.manage");

  const reason = input.reason.trim();

  if (!reason) {
    throw new ValidationError("Give a reason for leaving this date out.");
  }

  try {
    return await withTransaction(database, async (transaction) => {
      const row = await insertExcludedDate(transaction, {
        locationId: actor.locationId,
        excludedDate: input.excludedDate,
        reason,
        createdByUserId: actor.userId,
      });

      await recordAudit(transaction, actor, {
        action: "scheduling.forecast-date-excluded",
        entityId: row.id,
        after: { excludedDate: row.excludedDate, reason: row.reason, active: true },
      });

      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("DATE_ALREADY_EXCLUDED", "This date is already left out of the forecast.");
    }

    throw error;
  }
}

/** Policy 6: deactivates an excluded date. Stored forecasts keep the dates they used. */
export async function removeExcludedDate(database: Database, actor: Actor, excludedDateId: string) {
  assertPermission(actor, "schedule.rules.manage");

  return withTransaction(database, async (transaction) => {
    const [row] = await deactivateExcludedDateRow(transaction, {
      id: excludedDateId,
      locationId: actor.locationId,
      userId: actor.userId,
    });

    if (!row) {
      throw new NotFoundError("excluded date");
    }

    await recordAudit(transaction, actor, {
      action: "scheduling.forecast-date-restored",
      entityId: row.id,
      before: { excludedDate: row.excludedDate, reason: row.reason, active: true },
      after: { active: false },
    });
  });
}

/** Policy 14: the stored forecasts that sized a period's shifts, for the generator run. */
export async function findPeriodForecastIds(executor: DatabaseExecutor, periodId: string) {
  const rows = await executor
    .selectDistinct({ id: shifts.demandForecastId })
    .from(shifts)
    .where(eq(shifts.schedulePeriodId, periodId));

  return rows.flatMap((row) => (row.id ? [row.id] : [])).sort();
}

