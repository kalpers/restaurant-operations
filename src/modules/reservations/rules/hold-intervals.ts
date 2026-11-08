import type {
  HoldSettings,
  Interval,
  ReservationStatus,
} from "../types";

const MINUTE_MS = 60 * 1000;

function shift(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

/**
 * The window in which one reservation conflicts with another for the same table:
 * `[reservation_at - pre_hold, reservation_at + expected_duration + post_grace)`.
 * It is not the walk-in hold, which is shorter.
 */
export function reservationPlanningInterval(
  reservation: { reservationAt: Date; expectedDurationMinutes: number },
  settings: HoldSettings,
): Interval {
  return {
    start: shift(reservation.reservationAt, -settings.preHoldMinutes),
    end: shift(
      reservation.reservationAt,
      reservation.expectedDurationMinutes + settings.postGraceMinutes,
    ),
  };
}

/**
 * The window in which an unrelated walk-in may not take a reserved table:
 * `[reservation_at - pre_hold, reservation_at + post_grace)`.
 */
export function walkInHoldInterval(
  reservation: { reservationAt: Date },
  settings: HoldSettings,
): Interval {
  return {
    start: shift(reservation.reservationAt, -settings.preHoldMinutes),
    end: shift(reservation.reservationAt, settings.postGraceMinutes),
  };
}

/** Half-open overlap, so intervals that only touch don't conflict. */
export function intervalsOverlap(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

/** Half-open containment. */
export function intervalContains(interval: Interval, instant: Date): boolean {
  return interval.start <= instant && instant < interval.end;
}

/**
 * Statuses that still plan to use their tables. A seated reservation no longer does: the
 * Table Session is what occupies the table, and the planning rows are ended.
 */
const PLANNING_STATUSES: ReadonlySet<ReservationStatus> = new Set([
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
]);

export function reservationBlocksPlanning(status: ReservationStatus): boolean {
  return PLANNING_STATUSES.has(status);
}

/**
 * The one place that decides whether a reservation holds its tables right now. A hold is
 * a planning protection and never occupancy.
 */
export function isHoldActive(
  reservation: { status: ReservationStatus; reservationAt: Date },
  now: Date,
  settings: HoldSettings,
): boolean {
  return (
    reservationBlocksPlanning(reservation.status) &&
    intervalContains(walkInHoldInterval(reservation, settings), now)
  );
}

/**
 * Whether another reservation's planning window still matters. One that has already
 * ended is history, not a conflict.
 */
export function planningWindowIsCurrent(
  reservation: { reservationAt: Date; expectedDurationMinutes: number },
  now: Date,
  settings: HoldSettings,
): boolean {
  return reservationPlanningInterval(reservation, settings).end > now;
}
