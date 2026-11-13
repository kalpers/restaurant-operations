import {
  compareDecimals,
  divideRoundHalfUp,
  wholeQuotientCeiling,
} from "@/shared/decimal/decimal";
import { businessDateOf, type BusinessDateSettings } from "@/shared/time/business-date-service";
import { addDays, localMinutesOf } from "@/shared/time/zoned-time";

// Phase 24 demand forecast rules (policies 3, 4, 8 and 9). Pure and deterministic: the same
// history, bookings, settings and ratios always give the same forecast and suggestions.

export const DEMAND_MEASURES = [
  "DINING_COVERS",
  "BAR_CHECKS",
  "TAKEOUT_CHECKS",
  "ALL_CHECKS",
] as const;

export type DemandMeasure = (typeof DEMAND_MEASURES)[number];

export const MEASURE_LABELS: Record<DemandMeasure, { name: string; unit: string }> = {
  DINING_COVERS: { name: "Dining covers", unit: "covers" },
  BAR_CHECKS: { name: "Bar checks", unit: "bar checks" },
  TAKEOUT_CHECKS: { name: "Takeout checks", unit: "takeout checks" },
  ALL_CHECKS: { name: "All checks", unit: "checks" },
};

/** History is never looked for further back than this many weeks (policy 3). */
export const MAXIMUM_HISTORY_WEEKS = 12;

export type ForecastSettings = {
  lookbackWeeks: number;
  minimumSamples: number;
};

export type HistoryCounts = Record<DemandMeasure, number>;

export type DateForecastStatus = "OK" | "NOT_ENOUGH_HISTORY" | "BOOKINGS_ONLY";

export type HourForecast = {
  hour: number;
  measure: DemandMeasure;
  /** Weighted same-weekday average, two places; null when there is not enough history. */
  historyValue: string | null;
  /** Covers already booked (DINING_COVERS only, else 0). */
  bookedValue: number;
  /** The figure used: history raised to the booked covers; null when neither applies. */
  forecastValue: string | null;
};

export type DateForecast = {
  businessDate: string;
  status: DateForecastStatus;
  /** The history dates used, newest first. */
  sampleDates: string[];
  hours: HourForecast[];
};

/**
 * Policy 3: the usable history dates for a target date: earlier dates with the same
 * weekday, newest first, within 12 weeks, before today's business date, not excluded and
 * with at least one closed check; the first `lookbackWeeks` of them.
 */
export function selectHistoryDates(input: {
  targetDate: string;
  today: string;
  openDates: ReadonlySet<string>;
  excludedDates: ReadonlySet<string>;
  lookbackWeeks: number;
}): string[] {
  const dates: string[] = [];

  for (let week = 1; week <= MAXIMUM_HISTORY_WEEKS && dates.length < input.lookbackWeeks; week += 1) {
    const date = addDays(input.targetDate, -7 * week);

    if (date >= input.today || input.excludedDates.has(date) || !input.openDates.has(date)) {
      continue;
    }

    dates.push(date);
  }

  return dates;
}

/**
 * Policy 3: the weighted mean of whole counts, newest first, weights n down to 1, as a
 * decimal string to two places (half up). Integer arithmetic only.
 */
export function weightedAverage(valuesNewestFirst: readonly number[]): string {
  const count = valuesNewestFirst.length;

  if (count === 0) {
    throw new Error("A weighted average needs at least one value.");
  }

  let numerator = 0;
  let denominator = 0;

  valuesNewestFirst.forEach((value, index) => {
    const weight = count - index;

    numerator += weight * value;
    denominator += weight;
  });

  return divideRoundHalfUp(String(numerator), String(denominator), 2);
}

function maxDecimal(value: string, floor: number): string {
  const floorText = `${floor}.00`;

  return compareDecimals(value, floorText) >= 0 ? value : floorText;
}

/**
 * Policies 3 and 4: one target date's forecast for every hour and measure. `history` maps
 * a history date to its hour counts; `booked` maps an hour to booked covers for the target.
 */
export function forecastDate(input: {
  targetDate: string;
  sampleDates: readonly string[];
  settings: ForecastSettings;
  history: ReadonlyMap<string, ReadonlyMap<number, HistoryCounts>>;
  booked: ReadonlyMap<number, number>;
}): DateForecast {
  const enough = input.sampleDates.length >= input.settings.minimumSamples;
  const anyBooked = [...input.booked.values()].some((covers) => covers > 0);
  const status: DateForecastStatus = enough ? "OK" : anyBooked ? "BOOKINGS_ONLY" : "NOT_ENOUGH_HISTORY";
  const hours: HourForecast[] = [];

  for (let hour = 0; hour < 24; hour += 1) {
    for (const measure of DEMAND_MEASURES) {
      const historyValue = enough
        ? weightedAverage(
            input.sampleDates.map((date) => input.history.get(date)?.get(hour)?.[measure] ?? 0),
          )
        : null;
      const bookedValue = measure === "DINING_COVERS" ? (input.booked.get(hour) ?? 0) : 0;
      let forecastValue: string | null = historyValue;

      if (measure === "DINING_COVERS") {
        if (historyValue !== null) {
          forecastValue = maxDecimal(historyValue, bookedValue);
        } else if (status === "BOOKINGS_ONLY") {
          forecastValue = `${bookedValue}.00`;
        }
      }

      hours.push({ hour, measure, historyValue, bookedValue, forecastValue });
    }
  }

  return { businessDate: input.targetDate, status, sampleDates: [...input.sampleDates], hours };
}

/** A business date and local hour a shift window touches. */
export type WindowHour = { businessDate: string; hour: number };

/**
 * Policy 8: every local hour a shift's `[start, end)` touches, as business date and hour,
 * in time order. Works across midnight, the business-day cutoff and daylight-saving days.
 */
export function hoursTouched(
  startAt: Date,
  endAt: Date,
  settings: BusinessDateSettings,
): WindowHour[] {
  const result: WindowHour[] = [];
  let instant = startAt.getTime();
  const end = endAt.getTime();

  while (instant < end) {
    const localMinutes = localMinutesOf(instant, settings.timeZone);

    result.push({
      businessDate: businessDateOf(instant, settings),
      hour: Math.floor(localMinutes / 60),
    });
    instant += (60 - (localMinutes % 60)) * 60_000;
  }

  return result;
}

export type StaffingRatio = {
  measure: DemandMeasure;
  /** Demand one employee handles in an hour, a positive decimal string. */
  unitsPerEmployeeHour: string;
  minimumEmployees: number;
  maximumEmployees: number;
};

export type SuggestionReason =
  | "FORECAST"
  | "MINIMUM_APPLIED"
  | "MAXIMUM_APPLIED"
  | "NO_RATIO"
  | "NOT_ENOUGH_HISTORY"
  /** The shift's first hour is before today's business date. */
  | "STARTED";

export type ShiftSuggestion = {
  /** Null when the shift isn't sized (no ratio or no forecast): it keeps its count. */
  suggestedCount: number | null;
  reason: SuggestionReason;
  measure: DemandMeasure | null;
  peak: {
    businessDate: string;
    hour: number;
    forecastValue: string;
    historyValue: string | null;
    bookedValue: number;
  } | null;
  sampleDates: string[];
  unitsPerEmployeeHour: string | null;
  rawCount: number | null;
  explanation: string;
};

export function hourLabel(hour: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${pad(hour)}:00–${pad(hour)}:59`;
}

function formatValue(value: string): string {
  return value.endsWith(".00") ? value.slice(0, -3) : value;
}

/**
 * Policies 8 and 9: a shift's suggested headcount. The busiest forecast hour of the
 * ratio's measure among the hours the shift touches, divided by the ratio and rounded up,
 * then held between the ratio's minimum and maximum, and never below 1.
 */
export function suggestShiftCount(input: {
  window: readonly WindowHour[];
  ratio: StaffingRatio | null;
  forecasts: ReadonlyMap<string, DateForecast>;
  positionName: string;
}): ShiftSuggestion {
  const { ratio } = input;

  if (!ratio) {
    return {
      suggestedCount: null,
      reason: "NO_RATIO",
      measure: null,
      peak: null,
      sampleDates: [],
      unitsPerEmployeeHour: null,
      rawCount: null,
      explanation: `${input.positionName} has no staffing ratio, so the shift keeps its count.`,
    };
  }

  let peak: ShiftSuggestion["peak"] = null;
  let sampleDates: string[] = [];

  for (const slot of input.window) {
    const forecast = input.forecasts.get(slot.businessDate);
    const hour = forecast?.hours.find(
      (entry) => entry.hour === slot.hour && entry.measure === ratio.measure,
    );

    if (!forecast || !hour || hour.forecastValue === null) {
      continue;
    }

    if (!peak || compareDecimals(hour.forecastValue, peak.forecastValue) > 0) {
      peak = {
        businessDate: slot.businessDate,
        hour: slot.hour,
        forecastValue: hour.forecastValue,
        historyValue: hour.historyValue,
        bookedValue: hour.bookedValue,
      };
      sampleDates = forecast.sampleDates;
    }
  }

  if (!peak) {
    return {
      suggestedCount: null,
      reason: "NOT_ENOUGH_HISTORY",
      measure: ratio.measure,
      peak: null,
      sampleDates: [],
      unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
      rawCount: null,
      explanation: "Not enough history for this date yet, so the shift keeps its count.",
    };
  }

  const rawCount = Number(wholeQuotientCeiling(peak.forecastValue, ratio.unitsPerEmployeeHour));
  const floor = Math.max(1, ratio.minimumEmployees);
  let suggestedCount = rawCount;
  let reason: SuggestionReason = "FORECAST";

  if (rawCount < floor) {
    suggestedCount = floor;
    reason = "MINIMUM_APPLIED";
  } else if (rawCount > ratio.maximumEmployees) {
    suggestedCount = ratio.maximumEmployees;
    reason = "MAXIMUM_APPLIED";
  }

  const { unit } = MEASURE_LABELS[ratio.measure];
  const parts: string[] = [];

  if (peak.historyValue !== null) {
    parts.push(`history ${formatValue(peak.historyValue)}`);
  }

  if (ratio.measure === "DINING_COVERS" && peak.bookedValue > 0) {
    parts.push(`booked ${peak.bookedValue}`);
  }

  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  let explanation =
    `Busiest hour ${hourLabel(peak.hour)}: ${formatValue(peak.forecastValue)} ${unit}${detail} ` +
    `÷ ${formatValue(ratio.unitsPerEmployeeHour)} per ${input.positionName.toLowerCase()} = ${rawCount}`;

  if (reason === "MINIMUM_APPLIED") {
    explanation += `, raised to the minimum of ${suggestedCount}`;
  } else if (reason === "MAXIMUM_APPLIED") {
    explanation += `, held to the maximum of ${suggestedCount}`;
  }

  return {
    suggestedCount,
    reason,
    measure: ratio.measure,
    peak,
    sampleDates,
    unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
    rawCount,
    explanation: `${explanation}.`,
  };
}
