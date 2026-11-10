import {
  addDays,
  localMinutesOf,
  localTimeOf,
  localToInstantLenient,
} from "@/shared/time/zoned-time";

// The day timeline's layout rules. Pure: no clock, no database. Every position is
// computed from real instants, so daylight-saving days get the right number of hours.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type Interval = { startMs: number; endMs: number };

/** The start of the local clock hour containing the instant. */
export function floorToLocalHour(instantMs: number, timeZone: string): number {
  const minutesIntoHour = localMinutesOf(instantMs, timeZone) % 60;
  const wholeMinute = instantMs - (((instantMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);

  return wholeMinute - minutesIntoHour * MINUTE_MS;
}

/** The instant itself when it's on a local hour, otherwise the next local hour. */
export function ceilToLocalHour(instantMs: number, timeZone: string): number {
  const floor = floorToLocalHour(instantMs, timeZone);

  return floor === instantMs ? instantMs : floor + HOUR_MS;
}

/**
 * From the hour at or before the earliest start to the hour at or after the latest end,
 * never narrower than 06:00 to the next midnight, local time.
 */
export function axisWindow(
  date: string,
  timeZone: string,
  intervals: readonly Interval[],
): Interval {
  let startMs = Number(localToInstantLenient(date, "06:00", timeZone));
  let endMs = Number(localToInstantLenient(addDays(date, 1), "00:00", timeZone));

  for (const interval of intervals) {
    startMs = Math.min(startMs, floorToLocalHour(interval.startMs, timeZone));
    endMs = Math.max(endMs, ceilToLocalHour(interval.endMs, timeZone));
  }

  return { startMs, endMs };
}

export type HourTick = { startMs: number; label: string };

/** One tick per real hour. A fall-back night repeats a label; spring-forward skips one. */
export function hourTicks(window: Interval, timeZone: string): HourTick[] {
  const ticks: HourTick[] = [];

  for (let at = window.startMs; at < window.endMs; at += HOUR_MS) {
    ticks.push({ startMs: at, label: localTimeOf(at, timeZone) });
  }

  return ticks;
}

/** Where a bar sits on the axis, as percentages, clipped to the window. */
export function barPlacement(
  window: Interval,
  bar: Interval,
): { leftPercent: number; widthPercent: number } {
  const span = window.endMs - window.startMs;
  const start = Math.max(bar.startMs, window.startMs);
  const end = Math.min(bar.endMs, window.endMs);

  return {
    leftPercent: ((start - window.startMs) / span) * 100,
    widthPercent: (Math.max(end - start, 0) / span) * 100,
  };
}

export type LaneItem = Interval & { key: string; rowKey: string };

/**
 * Bars in one row that overlap go in separate lanes. Intervals are half-open, so a shift
 * ending when the next starts shares its lane.
 */
export function assignLanes(items: readonly LaneItem[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const rows = new Map<string, LaneItem[]>();

  for (const item of items) {
    rows.set(item.rowKey, [...(rows.get(item.rowKey) ?? []), item]);
  }

  for (const rowItems of rows.values()) {
    const ordered = [...rowItems].sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        compareText(left.key, right.key),
    );
    const laneEnds: number[] = [];

    for (const item of ordered) {
      let lane = laneEnds.findIndex((end) => end <= item.startMs);

      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.endMs);
      } else {
        laneEnds[lane] = item.endMs;
      }

      lanes.set(item.key, lane);
    }
  }

  return lanes;
}

/** Unfilled slots on a shift. An over-filled shift has none. */
export function openSlots(required: number, filled: number): number {
  return Math.max(required - filled, 0);
}

export type HeadcountBar = Interval & { positionId: string };

/** People scheduled in each hour, per position. A bar touching part of an hour counts. */
export function hourlyHeadcount(
  ticks: readonly HourTick[],
  window: Interval,
  bars: readonly HeadcountBar[],
): { hourStartMs: number; byPosition: Record<string, number> }[] {
  return ticks.map((tick) => {
    const hourEnd = Math.min(tick.startMs + HOUR_MS, window.endMs);
    const byPosition: Record<string, number> = {};

    for (const bar of bars) {
      if (bar.startMs < hourEnd && bar.endMs > tick.startMs) {
        byPosition[bar.positionId] = (byPosition[bar.positionId] ?? 0) + 1;
      }
    }

    return { hourStartMs: tick.startMs, byPosition };
  });
}

export function minutesBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / MINUTE_MS);
}

/** Whole minutes as "h:mm". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `${hours}:${String(rest).padStart(2, "0")}`;
}

/** By code point, so the order doesn't depend on the runtime's locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortEmployees<
  T extends { displayName: string; employeeNumber: string; id: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (left, right) =>
      compareText(left.displayName, right.displayName) ||
      compareText(left.employeeNumber, right.employeeNumber) ||
      compareText(left.id, right.id),
  );
}

export function sortPositions<T extends { name: string; code: string; id: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.code, right.code) ||
      compareText(left.id, right.id),
  );
}

/** The number of distinct position colors before they repeat. */
export const POSITION_COLOR_COUNT = 8;

/** A position's color follows its place in the day's sorted positions. */
export function positionColorIndex(sortedIndex: number): number {
  return sortedIndex % POSITION_COLOR_COUNT;
}
