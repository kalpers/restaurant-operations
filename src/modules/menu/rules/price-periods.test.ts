import { describe, expect, it } from "vitest";

import { periodOccurrenceAt, periodPriceAt, periodsOverlap, type PricePeriodRule } from "./price-periods";

const ZONE = "America/Detroit";

function period(overrides: Partial<PricePeriodRule> = {}): PricePeriodRule {
  return {
    id: "p1",
    name: "Happy hour",
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: "16:00",
    endTime: "18:00",
    orderTypes: null,
    firstDate: null,
    lastDate: null,
    active: true,
    ...overrides,
  };
}

// 2026-11-16 is a Monday. Detroit is UTC-5 in November.
const at = (iso: string) => new Date(iso);

describe("periodOccurrenceAt", () => {
  it("applies inside [start, end) on a listed day only", () => {
    expect(periodOccurrenceAt(period(), at("2026-11-16T21:00:00Z"), ZONE, "BAR")).not.toBeNull();
    expect(periodOccurrenceAt(period(), at("2026-11-16T20:59:59Z"), ZONE, "BAR")).toBeNull();
    expect(periodOccurrenceAt(period(), at("2026-11-16T23:00:00Z"), ZONE, "BAR")).toBeNull();
    // Sunday 2026-11-15 17:00 local.
    expect(periodOccurrenceAt(period(), at("2026-11-15T22:00:00Z"), ZONE, "BAR")).toBeNull();
  });

  it("gives the end instant of the occurrence", () => {
    const occurrence = periodOccurrenceAt(period(), at("2026-11-16T22:30:00Z"), ZONE, null);

    expect(occurrence?.startDate).toBe("2026-11-16");
    expect(occurrence?.endsAt.toISOString()).toBe("2026-11-16T23:00:00.000Z");
  });

  it("belongs a past-midnight stretch to the day it started", () => {
    const late = period({ daysOfWeek: [5], startTime: "22:00", endTime: "01:00" });

    // Friday 2026-11-20 23:00 local and Saturday 00:30 local apply; Saturday 22:30 does not.
    expect(periodOccurrenceAt(late, at("2026-11-21T04:00:00Z"), ZONE, null)?.startDate).toBe("2026-11-20");
    const spill = periodOccurrenceAt(late, at("2026-11-21T05:30:00Z"), ZONE, null);

    expect(spill?.startDate).toBe("2026-11-20");
    expect(spill?.endsAt.toISOString()).toBe("2026-11-21T06:00:00.000Z");
    expect(periodOccurrenceAt(late, at("2026-11-22T03:30:00Z"), ZONE, null)).toBeNull();
  });

  it("limits by order type, and a general view sees only all-type periods", () => {
    const bar = period({ orderTypes: ["BAR"] });
    const inside = at("2026-11-16T21:30:00Z");

    expect(periodOccurrenceAt(bar, inside, ZONE, "BAR")).not.toBeNull();
    expect(periodOccurrenceAt(bar, inside, ZONE, "DINE_IN")).toBeNull();
    expect(periodOccurrenceAt(bar, inside, ZONE, null)).toBeNull();
  });

  it("respects first and last dates of the start day", () => {
    const dated = period({ firstDate: "2026-11-17", lastDate: "2026-11-18" });

    expect(periodOccurrenceAt(dated, at("2026-11-16T21:30:00Z"), ZONE, null)).toBeNull();
    expect(periodOccurrenceAt(dated, at("2026-11-17T21:30:00Z"), ZONE, null)).not.toBeNull();
    expect(periodOccurrenceAt(dated, at("2026-11-19T21:30:00Z"), ZONE, null)).toBeNull();

    const lateDated = period({ daysOfWeek: [3], startTime: "23:00", endTime: "02:00", lastDate: "2026-11-18" });

    // Thursday 2026-11-19 01:00 local still belongs to Wednesday the 18th.
    expect(periodOccurrenceAt(lateDated, at("2026-11-19T06:00:00Z"), ZONE, null)?.startDate).toBe("2026-11-18");
  });

  it("never applies an inactive period", () => {
    expect(periodOccurrenceAt(period({ active: false }), at("2026-11-16T21:30:00Z"), ZONE, null)).toBeNull();
  });

  it("follows the wall clock across a daylight-saving change", () => {
    // Sunday 2026-11-01: clocks fall back at 02:00. 01:30 happens twice; both are inside.
    const night = period({ daysOfWeek: [6], startTime: "23:00", endTime: "02:00" });

    expect(periodOccurrenceAt(night, at("2026-11-01T05:30:00Z"), ZONE, null)).not.toBeNull();
    expect(periodOccurrenceAt(night, at("2026-11-01T06:30:00Z"), ZONE, null)).not.toBeNull();
    // 02:30 local standard time is past the end.
    expect(periodOccurrenceAt(night, at("2026-11-01T07:30:00Z"), ZONE, null)).toBeNull();
  });
});

describe("periodsOverlap", () => {
  it("overlaps on a shared day and time for a shared order type", () => {
    expect(periodsOverlap(period(), period({ id: "p2", daysOfWeek: [5], startTime: "17:00", endTime: "19:00" }))).toBe(true);
  });

  it("does not overlap back to back or on other days", () => {
    expect(periodsOverlap(period(), period({ id: "p2", startTime: "18:00", endTime: "20:00" }))).toBe(false);
    expect(periodsOverlap(period(), period({ id: "p2", daysOfWeek: [0, 6] }))).toBe(false);
  });

  it("does not overlap for different order types, inactive periods or separate dates", () => {
    expect(periodsOverlap(period({ orderTypes: ["BAR"] }), period({ id: "p2", orderTypes: ["DINE_IN"] }))).toBe(false);
    expect(periodsOverlap(period({ orderTypes: ["BAR"] }), period({ id: "p2" }))).toBe(true);
    expect(periodsOverlap(period(), period({ id: "p2", active: false }))).toBe(false);
    expect(
      periodsOverlap(period({ lastDate: "2026-11-30" }), period({ id: "p2", firstDate: "2026-12-01" })),
    ).toBe(false);
  });

  it("sees a midnight crossing that wraps from Saturday into Sunday", () => {
    const saturdayLate = period({ daysOfWeek: [6], startTime: "22:00", endTime: "02:00" });
    const sundayEarly = period({ id: "p2", daysOfWeek: [0], startTime: "00:30", endTime: "01:00" });

    expect(periodsOverlap(saturdayLate, sundayEarly)).toBe(true);
  });
});

describe("periodPriceAt", () => {
  it("returns the price of the period that applies and prices the item", () => {
    const prices = new Map([["p1", "4.00"]]);
    const result = periodPriceAt([period(), period({ id: "p2" })], prices, at("2026-11-16T21:30:00Z"), ZONE, "BAR");

    expect(result?.price).toBe("4.00");
    expect(result?.period.id).toBe("p1");
    expect(periodPriceAt([period()], prices, at("2026-11-16T23:30:00Z"), ZONE, "BAR")).toBeNull();
    expect(periodPriceAt([period()], new Map(), at("2026-11-16T21:30:00Z"), ZONE, "BAR")).toBeNull();
  });
});
