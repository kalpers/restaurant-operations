import { addDays, localDateOf, localMinutesOf, localToInstantLenient } from "@/shared/time/zoned-time";

// Phase 22 reminders (D4, D15, policy 14). Pure, so the window and quiet hours are unit-tested.

/** Reminders go out only between these local times (minutes after midnight). */
export const QUIET_HOURS_END_MINUTES = 9 * 60;
export const QUIET_HOURS_START_MINUTES = 21 * 60;

/**
 * True when a CONFIRMED reservation is due its reminder now: it starts within the window, and
 * it was booked before the window opened (a guest who booked an hour ahead needs no reminder).
 */
export function isReminderDue(input: {
  reservationAt: Date;
  createdAt: Date;
  now: Date;
  hoursBefore: number;
}): boolean {
  if (input.hoursBefore <= 0) {
    return false;
  }

  const windowOpens = input.reservationAt.getTime() - input.hoursBefore * 3_600_000;

  return (
    input.reservationAt.getTime() > input.now.getTime() &&
    input.now.getTime() >= windowOpens &&
    input.createdAt.getTime() < windowOpens
  );
}

/**
 * When a reminder may be sent: now, inside 09:00–21:00 local time; otherwise the next 09:00.
 * Null when that is not before the reservation starts, so the reminder is skipped.
 */
export function reminderSendAfter(now: Date, reservationAt: Date, timeZone: string): Date | null {
  const minutes = localMinutesOf(now, timeZone);

  if (minutes >= QUIET_HOURS_END_MINUTES && minutes < QUIET_HOURS_START_MINUTES) {
    return now;
  }

  const today = localDateOf(now, timeZone);
  const date = minutes < QUIET_HOURS_END_MINUTES ? today : addDays(today, 1);
  const nineAm = localToInstantLenient(date, "09:00", timeZone);

  return nineAm.getTime() < reservationAt.getTime() ? nineAm : null;
}
