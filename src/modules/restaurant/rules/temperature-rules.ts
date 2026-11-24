import { compareDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 36 part 2 (policy 6): temperature log rules. Pure, so they are unit-tested on their own.

/** The longest range the log and its export cover at once. */
export const MAX_TEMPERATURE_LOG_DAYS = 31;

/** Policy 6: in range against whichever bounds the point has (the database checks the same). */
export function isInRange(value: string, minimum: string | null, maximum: string | null): boolean {
  return (minimum === null || compareDecimals(value, minimum) >= 0) && (maximum === null || compareDecimals(value, maximum) <= 0);
}

/** A reading to one decimal place, within what a probe could show. */
export function readingValue(raw: string): string {
  const trimmed = raw.trim();

  if (!/^-?\d{1,3}(\.\d)?$/.test(trimmed) || compareDecimals(trimmed, "-100") < 0 || compareDecimals(trimmed, "600") > 0) {
    throw new BusinessRuleError("INVALID_TEMPERATURE", "Enter a temperature between -100 and 600, to one decimal place.");
  }

  return toScale(trimmed, 1);
}

/** Policy 6: an out-of-range reading needs a corrective action of 1 to 500 characters. */
export function correctiveActionFor(inRange: boolean, action: string | null | undefined): string | null {
  const trimmed = (action ?? "").trim();

  if (trimmed.length > 500) {
    throw new BusinessRuleError("CORRECTIVE_ACTION_TOO_LONG", "Keep the corrective action to 500 characters.");
  }

  if (!inRange && !trimmed) {
    throw new BusinessRuleError("CORRECTIVE_ACTION_REQUIRED", "This reading is out of range. Say what was done about it.");
  }

  return trimmed || null;
}

/** A point's range is a minimum, a maximum, or both, with the minimum not above the maximum. */
export function assertRange(minimum: string | null, maximum: string | null): void {
  if (minimum !== null && maximum !== null && compareDecimals(minimum, maximum) > 0) {
    throw new BusinessRuleError("INVALID_RANGE", "The lowest safe temperature can't be above the highest.");
  }
}

export type CheckStatus = { state: "NO_SCHEDULE" } | { state: "OK" | "OVERDUE"; dueAt: Date };

/**
 * Policy 6: whether a scheduled check is due, worked out on read and never stored. The next
 * check falls one interval after the last reading, or after the start of the business day when
 * there's none since then.
 */
export function checkStatus(
  intervalMinutes: number | null,
  lastTakenAt: Date | null,
  businessDayStart: Date,
  now: Date,
): CheckStatus {
  if (intervalMinutes === null) {
    return { state: "NO_SCHEDULE" };
  }

  const from = lastTakenAt && lastTakenAt > businessDayStart ? lastTakenAt : businessDayStart;
  const dueAt = new Date(from.getTime() + intervalMinutes * 60_000);

  return { state: now >= dueAt ? "OVERDUE" : "OK", dueAt };
}

/** How a range reads, e.g. "33.0–41.0 °F", "at least 135.0 °F", "no range". */
export function describeRange(minimum: string | null, maximum: string | null, unit: string): string {
  if (minimum !== null && maximum !== null) {
    return `${minimum}–${maximum} °${unit}`;
  }

  if (minimum !== null) {
    return `at least ${minimum} °${unit}`;
  }

  if (maximum !== null) {
    return `at most ${maximum} °${unit}`;
  }

  return "no range";
}
