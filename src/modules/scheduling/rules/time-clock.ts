// Phase 18 time clock rules (approved policies A3, A5, B13-B17, C18). Pure and deterministic:
// times in, whole seconds and decisions out. Hours and money are formatted elsewhere from
// whole seconds, so nothing here passes through a floating-point hour.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Policy A5: a shift starting within this window either side of the clock-in can be matched. */
export const SHIFT_MATCH_WINDOW_MS = 60 * MINUTE;
/** Policy B17: APPROACHING within this many hours of the threshold. */
export const APPROACHING_OVERTIME_MS = 4 * HOUR;
/** Policy C20: an entry longer than this is flagged. */
export const LONG_ENTRY_MS = 16 * HOUR;

export type BreakSpan = { startedAt: Date; endedAt: Date | null; paid: boolean };

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / SECOND));
}

/**
 * Policy C18: worked time = clock-out − clock-in − unpaid breaks, in whole seconds. An
 * unfinished break ends at `until` (the clock-out, or now for an open entry). Paid breaks count
 * as worked.
 */
export function workedSeconds(
  entry: { clockInAt: Date; clockOutAt: Date | null },
  breaks: readonly BreakSpan[],
  now: Date = new Date(),
): number {
  const until = entry.clockOutAt ?? now;
  const total = until.getTime() - entry.clockInAt.getTime();
  const unpaid = breaks
    .filter((span) => !span.paid)
    .reduce((sum, span) => {
      const end = Math.min((span.endedAt ?? until).getTime(), until.getTime());
      const start = Math.max(span.startedAt.getTime(), entry.clockInAt.getTime());

      return sum + Math.max(0, end - start);
    }, 0);

  return seconds(total - unpaid);
}

export type ShiftCandidate = {
  assignmentId: string;
  positionId: string;
  locationId: string;
  startAt: Date;
};

/**
 * Policy A5: the employee's assignment for the same Position and Location whose shift starts
 * within 60 minutes either side of the clock-in. Closest start wins; ties go to the lower
 * assignment UUID. Null means the entry is unscheduled.
 */
export function matchShift(
  clockIn: { at: Date; positionId: string; locationId: string },
  candidates: readonly ShiftCandidate[],
): string | null {
  const matches = candidates
    .filter(
      (candidate) =>
        candidate.positionId === clockIn.positionId &&
        candidate.locationId === clockIn.locationId &&
        Math.abs(candidate.startAt.getTime() - clockIn.at.getTime()) <= SHIFT_MATCH_WINDOW_MS,
    )
    .sort((left, right) => {
      const distance =
        Math.abs(left.startAt.getTime() - clockIn.at.getTime()) -
        Math.abs(right.startAt.getTime() - clockIn.at.getTime());

      return distance !== 0 ? distance : left.assignmentId.localeCompare(right.assignmentId);
    });

  return matches[0]?.assignmentId ?? null;
}

export type WeekEntry = { id: string; clockInAt: Date; workedSeconds: number; businessDate?: string };
export type OvertimeSplit = { regularSeconds: number; overtimeSeconds: number };

/** Phase 20 (D18): within this many hours of the daily threshold, the warning shows. */
export const APPROACHING_DAILY_OVERTIME_MS = 1 * HOUR;

/**
 * Policy B15: one employee's entries for one work week, ordered by clock-in (ties: entry
 * UUID). Worked time accumulates, and time past the threshold is overtime, so an entry that
 * crosses the threshold is split and later work is overtime first.
 *
 * Phase 20 (policy 19, D18): with a daily threshold, each business date's hours past it are
 * overtime first (latest work first, the same way). Weekly overtime then counts only the hours
 * that were still regular, so no hour is overtime twice.
 */
export function allocateOvertime(
  entries: readonly WeekEntry[],
  thresholdSeconds: number,
  dailyThresholdSeconds: number | null = null,
): Map<string, OvertimeSplit> {
  const ordered = [...entries].sort((left, right) => {
    const difference = left.clockInAt.getTime() - right.clockInAt.getTime();

    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
  const dailyOvertime = new Map<string, number>();

  if (dailyThresholdSeconds !== null) {
    const byDate = new Map<string, number>();

    for (const entry of ordered) {
      const date = entry.businessDate ?? "";
      const before = byDate.get(date) ?? 0;
      const regular = Math.min(entry.workedSeconds, Math.max(0, dailyThresholdSeconds - before));

      dailyOvertime.set(entry.id, entry.workedSeconds - regular);
      byDate.set(date, before + entry.workedSeconds);
    }
  }

  const result = new Map<string, OvertimeSplit>();
  let accumulated = 0;

  for (const entry of ordered) {
    const daily = dailyOvertime.get(entry.id) ?? 0;
    const remaining = entry.workedSeconds - daily;
    const regularSeconds = Math.min(remaining, Math.max(0, thresholdSeconds - accumulated));

    result.set(entry.id, { regularSeconds, overtimeSeconds: entry.workedSeconds - regularSeconds });
    accumulated += remaining;
  }

  return result;
}

export type OvertimeState = "NONE" | "APPROACHING" | "OVERTIME";

/** Policy B17: from the week's worked seconds so far, including an open entry's elapsed time. */
export function overtimeState(
  weekSeconds: number,
  thresholdSeconds: number,
  daily: { todaySeconds: number; thresholdSeconds: number | null } = { todaySeconds: 0, thresholdSeconds: null },
): OvertimeState {
  if (weekSeconds > thresholdSeconds || (daily.thresholdSeconds !== null && daily.todaySeconds > daily.thresholdSeconds)) {
    return "OVERTIME";
  }

  // Phase 20 (D18): the daily line warns within an hour of it.
  if (
    daily.thresholdSeconds !== null &&
    daily.todaySeconds >= daily.thresholdSeconds - APPROACHING_DAILY_OVERTIME_MS / SECOND
  ) {
    return "APPROACHING";
  }

  return weekSeconds >= thresholdSeconds - APPROACHING_OVERTIME_MS / SECOND ? "APPROACHING" : "NONE";
}

/** Hours as "40.00" (the scheduling rules format) to whole seconds. */
export function hoursToSeconds(hours: string): number {
  const [whole, fraction = ""] = hours.split(".");
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));

  return hundredths * 36;
}

export type EntryFlags = {
  unscheduled: boolean;
  late: boolean;
  earlyOut: boolean;
  long: boolean;
};

/** Policy C20: flags for one closed entry against the shift it was matched to, if any. */
export function entryFlags(
  entry: { clockInAt: Date; clockOutAt: Date | null },
  shift: { startAt: Date; endAt: Date } | null,
  graceMinutes: number,
): EntryFlags {
  const grace = graceMinutes * MINUTE;
  const out = entry.clockOutAt;

  return {
    unscheduled: shift === null,
    late: shift !== null && entry.clockInAt.getTime() > shift.startAt.getTime() + grace,
    earlyOut: shift !== null && out !== null && out.getTime() < shift.endAt.getTime() - grace,
    long: out !== null && out.getTime() - entry.clockInAt.getTime() > LONG_ENTRY_MS,
  };
}
