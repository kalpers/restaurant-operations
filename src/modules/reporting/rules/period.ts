import { ValidationError } from "@/shared/errors/app-error";

/** The longest range one report may cover, to keep aggregation queries bounded. */
export const MAX_REPORT_DAYS = 92;

function dayNumber(date: string): number {
  return (
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) /
    86_400_000
  );
}

/** Inclusive number of business dates from `from` to `to`. */
export function daysInRange(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

export function assertValidRange(from: string, to: string): void {
  if (from > to) {
    throw new ValidationError("The start date must be on or before the end date.");
  }

  if (daysInRange(from, to) > MAX_REPORT_DAYS) {
    throw new ValidationError(`A report can cover at most ${MAX_REPORT_DAYS} days.`);
  }
}
