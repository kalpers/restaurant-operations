import { describe, expect, it } from "vitest";

import { businessDateOf, businessDateRangeBounds } from "./business-date-service";

const settings = { timeZone: "America/Detroit", businessDayCutoff: "04:00:00" };

describe("businessDateOf", () => {
  it("keeps Saturday 1:15 AM on Friday's business date", () => {
    // 2030-01-12 is a Saturday; 06:15 UTC is 01:15 in Detroit.
    expect(businessDateOf(new Date("2030-01-12T06:15:00Z"), settings)).toBe(
      "2030-01-11",
    );
  });

  it("starts the new business date exactly at the cutoff", () => {
    expect(businessDateOf(new Date("2030-01-12T08:59:59Z"), settings)).toBe(
      "2030-01-11",
    );
    expect(businessDateOf(new Date("2030-01-12T09:00:00Z"), settings)).toBe(
      "2030-01-12",
    );
  });

  it("uses the location's clock, not the UTC calendar date", () => {
    // 2030-01-12 02:00 UTC is 21:00 on the 11th in Detroit.
    expect(businessDateOf(new Date("2030-01-12T02:00:00Z"), settings)).toBe(
      "2030-01-11",
    );
  });

  it("crosses a month and a leap day", () => {
    expect(businessDateOf(new Date("2028-03-01T07:00:00Z"), settings)).toBe(
      "2028-02-29",
    );
  });

  it("follows the local clock on a daylight-saving night", () => {
    // 2030-03-10 springs forward at 2:00 AM. 3:30 AM EDT is 07:30 UTC, still before 4:00.
    expect(businessDateOf(new Date("2030-03-10T07:30:00Z"), settings)).toBe(
      "2030-03-09",
    );
    // 4:00 AM EDT is 08:00 UTC, an hour earlier by UTC than on a standard-time night.
    expect(businessDateOf(new Date("2030-03-10T08:00:00Z"), settings)).toBe(
      "2030-03-10",
    );
  });

  it("treats a midnight cutoff as the plain local date", () => {
    expect(
      businessDateOf(new Date("2030-01-12T06:15:00Z"), {
        ...settings,
        businessDayCutoff: "00:00",
      }),
    ).toBe("2030-01-12");
  });
});

describe("businessDateRangeBounds", () => {
  it("covers a single business date from cutoff to the next cutoff", () => {
    const { start, end } = businessDateRangeBounds("2030-01-11", "2030-01-11", settings);

    expect(start.toISOString()).toBe("2030-01-11T09:00:00.000Z");
    expect(end.toISOString()).toBe("2030-01-12T09:00:00.000Z");
    expect(businessDateOf(start, settings)).toBe("2030-01-11");
    expect(businessDateOf(new Date(end.getTime() - 1), settings)).toBe("2030-01-11");
    expect(businessDateOf(end, settings)).toBe("2030-01-12");
  });

  it("includes the 1:15 AM sale in the previous business date", () => {
    const { start, end } = businessDateRangeBounds("2030-01-11", "2030-01-11", settings);
    const lateSale = new Date("2030-01-12T06:15:00Z");

    expect(lateSale >= start && lateSale < end).toBe(true);
  });

  it("spans a multi-day range", () => {
    const { start, end } = businessDateRangeBounds("2030-01-07", "2030-01-13", settings);

    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("is 23 hours on the spring-forward business date and 25 on the fall-back one", () => {
    // 2030 DST in Detroit: March 10 and November 3.
    const spring = businessDateRangeBounds("2030-03-09", "2030-03-09", settings);
    const fall = businessDateRangeBounds("2030-11-02", "2030-11-02", settings);

    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("starts at the next existing moment when the cutoff falls in a DST gap", () => {
    const gap = { timeZone: "America/Detroit", businessDayCutoff: "02:30:00" };
    const { start } = businessDateRangeBounds("2030-03-10", "2030-03-10", gap);

    expect(start.toISOString()).toBe("2030-03-10T07:00:00.000Z");
    expect(businessDateOf(start, gap)).toBe("2030-03-10");
  });
});
