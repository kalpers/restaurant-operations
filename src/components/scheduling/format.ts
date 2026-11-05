import { localTimeOf } from "@/shared/time/zoned-time";
import { DAYS_OF_WEEK } from "@/modules/scheduling/types";

export function shiftTimes(
  shift: { startAt: Date; endAt: Date },
  timeZone: string,
): string {
  return `${localTimeOf(shift.startAt, timeZone)} to ${localTimeOf(shift.endAt, timeZone)}`;
}

/** "17:00:00" from PostgreSQL as "17:00". */
export function shortTime(time: string | null): string {
  return time ? time.slice(0, 5) : "";
}

export const DAY_OPTIONS = DAYS_OF_WEEK.map((label, value) => ({
  value: String(value),
  label,
}));

export const YES_NO_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "true", label: "Yes, prefer" },
  { value: "false", label: "Prefer not" },
];

export function flagOption(value: boolean | null): string {
  return value === null ? "" : String(value);
}
