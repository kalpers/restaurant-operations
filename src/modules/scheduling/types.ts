// Constrained strings shared by the validators and services. PostgreSQL checks the same
// lists, so a value that gets past the application still can't be stored.

export const SCHEDULE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const ASSIGNMENT_SOURCES = ["MANUAL", "GENERATED", "SHIFT_SWAP"] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export const AVAILABILITY_TYPES = ["AVAILABLE", "UNAVAILABLE"] as const;
export type AvailabilityType = (typeof AVAILABILITY_TYPES)[number];

export const TIME_OFF_TYPES = ["VACATION", "SICK", "PERSONAL", "OTHER"] as const;
export type TimeOffType = (typeof TIME_OFF_TYPES)[number];

export const GENERATION_MODES = ["GENERATE_DRAFT", "FILL_OPEN_SHIFTS"] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const HOURS_PATTERN = /^\d{1,4}(\.\d{1,2})?$/;

/** NUMERIC(6,2) as a decimal string. PostgreSQL would silently round extra places. */
export function isValidHours(value: string): boolean {
  return HOURS_PATTERN.test(value);
}

/** Exact, by string parsing: hours never pass through a floating-point value. */
export function hoursToMs(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  return hundredths * 36_000;
}

/** For display only. */
export function msToHours(ms: number): string {
  return (Math.round(ms / 36_000) / 100).toFixed(2);
}
