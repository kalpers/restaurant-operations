import { divideRoundHalfUp } from "@/shared/decimal/decimal";
import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";

/** Whole seconds as hours to two places, e.g. "7.50". Exact: no floating-point hours. */
export function hoursFrom(seconds: number): string {
  return divideRoundHalfUp(String(seconds), "3600", 2);
}

/** "2026-11-10 17:05" in the Location's time zone. */
export function clockTime(iso: string | null, timeZone: string): string {
  if (!iso) {
    return "";
  }

  const instant = new Date(iso);

  return `${localDateOf(instant, timeZone)} ${localTimeOf(instant, timeZone)}`;
}

export const OVERTIME_LABEL = { NONE: "On track", APPROACHING: "Near overtime", OVERTIME: "In overtime" } as const;
export const OVERTIME_TONE = { NONE: "neutral", APPROACHING: "warning", OVERTIME: "danger" } as const;
