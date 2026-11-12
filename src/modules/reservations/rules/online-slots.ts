import { addDays, dayOfWeek, localToInstant, timeToMinutes } from "@/shared/time/zoned-time";

// Phase 22 online availability (D9, policy 8). Pure, so periods, lead time, the booking window,
// pacing and daylight-saving days are unit-tested. The booking transaction runs it again under
// a location lock, so the times it offers are the times that can be booked.

export type BookingPeriod = { weekday: number; startsAt: string; endsAt: string };

export type SlotSettings = {
  minLeadMinutes: number;
  maxDaysAhead: number;
  slotIntervalMinutes: number;
  maxCoversPerSlot: number;
  maxPartySize: number;
};

export type OfferedSlot = { localTime: string; at: Date };

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The slot a local time falls in: its minutes rounded down to the interval. */
export function slotKey(localMinutes: number, intervalMinutes: number): string {
  return toTime(Math.floor(localMinutes / intervalMinutes) * intervalMinutes);
}

/** True when the date is today or later and within the booking window. */
export function isWithinBookingWindow(localDate: string, today: string, maxDaysAhead: number): boolean {
  return localDate >= today && localDate <= addDays(today, maxDaysAhead);
}

/**
 * The local start times offered on a date for a party. A time is offered when it is in one of
 * the weekday's periods (start included, end excluded), exists on that date (daylight-saving
 * gaps are skipped), is at least the lead time away, and the covers already booked in its slot
 * plus this party stay within the pacing limit.
 */
export function listOfferedSlots(input: {
  localDate: string;
  today: string;
  timeZone: string;
  now: Date;
  partySize: number;
  periods: readonly BookingPeriod[];
  settings: SlotSettings;
  /** Covers of active reservations per slot key ("HH:MM"). */
  bookedCovers: ReadonlyMap<string, number>;
}): OfferedSlot[] {
  const { settings } = input;

  if (
    input.partySize < 1 ||
    input.partySize > settings.maxPartySize ||
    !isWithinBookingWindow(input.localDate, input.today, settings.maxDaysAhead)
  ) {
    return [];
  }

  const weekday = dayOfWeek(input.localDate);
  const earliest = input.now.getTime() + settings.minLeadMinutes * 60_000;
  const seen = new Set<string>();
  const slots: OfferedSlot[] = [];

  for (const period of input.periods.filter((row) => row.weekday === weekday)) {
    const end = timeToMinutes(period.endsAt);

    for (let minutes = timeToMinutes(period.startsAt); minutes < end; minutes += settings.slotIntervalMinutes) {
      const localTime = toTime(minutes);
      const at = localToInstant(input.localDate, localTime, input.timeZone);
      const covers = input.bookedCovers.get(slotKey(minutes, settings.slotIntervalMinutes)) ?? 0;

      if (
        !at ||
        seen.has(localTime) ||
        at.getTime() < earliest ||
        covers + input.partySize > settings.maxCoversPerSlot
      ) {
        continue;
      }

      seen.add(localTime);
      slots.push({ localTime, at });
    }
  }

  return slots.sort((left, right) => left.at.getTime() - right.at.getTime());
}

/** Refuses booking hours that overlap on one weekday or end before they start. */
export function findPeriodProblem(periods: readonly BookingPeriod[]): string | null {
  for (const period of periods) {
    if (timeToMinutes(period.endsAt) <= timeToMinutes(period.startsAt)) {
      return "Each period must end after it starts, on the same day.";
    }
  }

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const day = periods
      .filter((period) => period.weekday === weekday)
      .sort((left, right) => timeToMinutes(left.startsAt) - timeToMinutes(right.startsAt));

    for (let index = 1; index < day.length; index += 1) {
      if (timeToMinutes(day[index]!.startsAt) < timeToMinutes(day[index - 1]!.endsAt)) {
        return "Booking periods on the same day can't overlap.";
      }
    }
  }

  return null;
}
