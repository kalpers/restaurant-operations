import { addDecimals, divideRoundHalfUp, multiplyExact } from "@/shared/decimal/decimal";
import { addDays } from "@/shared/time/zoned-time";

// Same-weekday history rules shared by the Phase 24 staffing forecast and the Phase 25 item
// forecast (Phase 25 policy 1). Pure and deterministic.

/** History is never looked for further back than this many weeks (Phase 24 policy 3). */
export const MAXIMUM_HISTORY_WEEKS = 12;

/**
 * Phase 24 policy 3: the usable history dates for a target date: earlier dates with the same
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
 * Phase 24 policy 3: the weighted mean of whole counts, newest first, weights n down to 1, as a
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

/**
 * Phase 25 policy 1: the same weighting over decimal strings, newest first, rounded half up to
 * `scale` places. Decimal arithmetic only.
 */
export function weightedAverageDecimal(valuesNewestFirst: readonly string[], scale: number): string {
  const count = valuesNewestFirst.length;

  if (count === 0) {
    throw new Error("A weighted average needs at least one value.");
  }

  let numerator = "0";

  valuesNewestFirst.forEach((value, index) => {
    numerator = addDecimals(numerator, multiplyExact(value, String(count - index)));
  });

  return divideRoundHalfUp(numerator, String((count * (count + 1)) / 2), scale);
}
