import { describe, expect, it } from "vitest";

import { businessDateOf } from "./business-date-service";

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
