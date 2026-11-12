import { describe, expect, it } from "vitest";

import { findPeriodProblem, isWithinBookingWindow, listOfferedSlots, slotKey, type SlotSettings } from "./online-slots";

const TZ = "America/Detroit";
const settings: SlotSettings = {
  minLeadMinutes: 120,
  maxDaysAhead: 30,
  slotIntervalMinutes: 30,
  maxCoversPerSlot: 10,
  maxPartySize: 6,
};
// Friday 2026-11-20; "now" is 10:00 Detroit (15:00 UTC) the day before.
const base = {
  localDate: "2026-11-20",
  today: "2026-11-19",
  timeZone: TZ,
  now: new Date("2026-11-19T15:00:00Z"),
  partySize: 4,
  periods: [{ weekday: 5, startsAt: "17:00:00", endsAt: "19:00:00" }],
  settings,
  bookedCovers: new Map<string, number>(),
};
const times = (input: Partial<typeof base> & { settings?: SlotSettings } = {}) =>
  listOfferedSlots({ ...base, ...input }).map((slot) => slot.localTime);

describe("listOfferedSlots (Phase 22 D9)", () => {
  it("offers every interval inside the period, start included and end excluded", () => {
    expect(times()).toEqual(["17:00", "17:30", "18:00", "18:30"]);
    expect(listOfferedSlots(base)[0]!.at).toEqual(new Date("2026-11-20T22:00:00Z"));
  });

  it("offers nothing on a weekday without periods, or for a party over the limit", () => {
    expect(times({ localDate: "2026-11-21" })).toEqual([]);
    expect(times({ partySize: 7 })).toEqual([]);
    expect(times({ partySize: 0 })).toEqual([]);
  });

  it("keeps the lead time", () => {
    // 15:30 Detroit on the day: 17:00 is within the two-hour lead time; 17:30 is not.
    expect(times({ today: "2026-11-20", now: new Date("2026-11-20T20:30:00Z") })).toEqual(["17:30", "18:00", "18:30"]);
  });

  it("keeps the booking window", () => {
    expect(times({ today: "2026-10-21" })).toEqual(["17:00", "17:30", "18:00", "18:30"]);
    expect(times({ today: "2026-10-20" })).toEqual([]);
    expect(times({ today: "2026-11-21" })).toEqual([]);
    expect(isWithinBookingWindow("2026-11-20", "2026-11-20", 0)).toBe(true);
  });

  it("applies pacing per slot", () => {
    const bookedCovers = new Map([["17:30", 7], ["18:00", 6]]);

    expect(times({ bookedCovers })).toEqual(["17:00", "18:00", "18:30"]);
    expect(times({ bookedCovers, partySize: 5 })).toEqual(["17:00", "18:30"]);
  });

  it("skips times that don't exist on a spring-forward night", () => {
    // 2027-03-14 is a Sunday; 02:00-03:00 doesn't exist in Detroit.
    const slots = times({
      localDate: "2027-03-14",
      today: "2027-03-01",
      now: new Date("2027-03-01T15:00:00Z"),
      periods: [{ weekday: 0, startsAt: "01:00:00", endsAt: "04:00:00" }],
    });

    expect(slots).toEqual(["01:00", "01:30", "03:00", "03:30"]);
  });

  it("buckets a time into its slot", () => {
    expect(slotKey(17 * 60 + 44, 30)).toBe("17:30");
    expect(slotKey(17 * 60 + 44, 15)).toBe("17:30");
    expect(slotKey(17 * 60 + 45, 15)).toBe("17:45");
  });
});

describe("findPeriodProblem", () => {
  it("accepts separate periods and refuses overlaps or inverted ones", () => {
    expect(
      findPeriodProblem([
        { weekday: 5, startsAt: "11:00", endsAt: "14:00" },
        { weekday: 5, startsAt: "17:00", endsAt: "21:00" },
        { weekday: 6, startsAt: "12:00", endsAt: "22:00" },
      ]),
    ).toBeNull();
    expect(
      findPeriodProblem([
        { weekday: 5, startsAt: "11:00", endsAt: "18:00" },
        { weekday: 5, startsAt: "17:00", endsAt: "21:00" },
      ]),
    ).toMatch(/overlap/);
    expect(findPeriodProblem([{ weekday: 1, startsAt: "21:00", endsAt: "02:00" }])).toMatch(/end after/);
  });
});
