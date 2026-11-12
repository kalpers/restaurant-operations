import { describe, expect, it } from "vitest";

import { isReminderDue, reminderSendAfter } from "./reminder-schedule";

const TZ = "America/Detroit";
const at = (iso: string) => new Date(iso);

describe("isReminderDue (Phase 22 policy 14)", () => {
  const reservationAt = at("2026-11-20T23:00:00Z"); // 18:00 Detroit
  const bookedEarly = at("2026-11-10T12:00:00Z");

  it("is due inside the window for a booking made before it opened", () => {
    expect(isReminderDue({ reservationAt, createdAt: bookedEarly, now: at("2026-11-20T00:00:00Z"), hoursBefore: 24 })).toBe(true);
  });

  it("is not due before the window, after the start, or with reminders off", () => {
    expect(isReminderDue({ reservationAt, createdAt: bookedEarly, now: at("2026-11-19T22:00:00Z"), hoursBefore: 24 })).toBe(false);
    expect(isReminderDue({ reservationAt, createdAt: bookedEarly, now: at("2026-11-20T23:30:00Z"), hoursBefore: 24 })).toBe(false);
    expect(isReminderDue({ reservationAt, createdAt: bookedEarly, now: at("2026-11-20T12:00:00Z"), hoursBefore: 0 })).toBe(false);
  });

  it("skips a booking made inside the window", () => {
    expect(
      isReminderDue({ reservationAt, createdAt: at("2026-11-20T20:00:00Z"), now: at("2026-11-20T21:00:00Z"), hoursBefore: 24 }),
    ).toBe(false);
  });
});

describe("reminderSendAfter (D15 quiet hours)", () => {
  it("sends at once between 09:00 and 21:00 local time", () => {
    const now = at("2026-11-20T15:00:00Z"); // 10:00 Detroit

    expect(reminderSendAfter(now, at("2026-11-21T23:00:00Z"), TZ)).toEqual(now);
  });

  it("waits for 09:00 the same morning before 09:00", () => {
    // 05:00 Detroit (EST, UTC-5) -> 09:00 is 14:00 UTC.
    expect(reminderSendAfter(at("2026-11-20T10:00:00Z"), at("2026-11-20T23:00:00Z"), TZ)).toEqual(at("2026-11-20T14:00:00Z"));
  });

  it("waits for the next morning after 21:00", () => {
    // 22:00 Detroit on the 19th -> 09:00 on the 20th.
    expect(reminderSendAfter(at("2026-11-20T03:00:00Z"), at("2026-11-20T23:00:00Z"), TZ)).toEqual(at("2026-11-20T14:00:00Z"));
  });

  it("skips a reminder that could only go after the reservation starts", () => {
    // 06:00 Detroit, reservation at 08:30 Detroit.
    expect(reminderSendAfter(at("2026-11-20T11:00:00Z"), at("2026-11-20T13:30:00Z"), TZ)).toBeNull();
  });

  it("treats 21:00 as quiet and 09:00 as open", () => {
    expect(reminderSendAfter(at("2026-11-20T14:00:00Z"), at("2026-11-21T23:00:00Z"), TZ)).toEqual(at("2026-11-20T14:00:00Z"));
    expect(reminderSendAfter(at("2026-11-21T02:00:00Z"), at("2026-11-22T23:00:00Z"), TZ)).toEqual(at("2026-11-21T14:00:00Z"));
  });
});
