import { describe, expect, it } from "vitest";

import {
  addDays,
  dayOfWeek,
  localDateOf,
  localMinutesOf,
  localTimeOf,
  localToInstant,
  localToInstantLenient,
  timeToMinutes,
} from "./zoned-time";

const DETROIT = "America/Detroit";

describe("local times at a location", () => {
  it("converts a normal local time in winter and in summer", () => {
    expect(localToInstant("2027-01-15", "17:00", DETROIT)?.toISOString()).toBe(
      "2027-01-15T22:00:00.000Z",
    );
    expect(localToInstant("2027-07-15", "17:00", DETROIT)?.toISOString()).toBe(
      "2027-07-15T21:00:00.000Z",
    );
  });

  it("returns null for a time the spring change skips", () => {
    expect(localToInstant("2027-03-14", "02:30", DETROIT)).toBeNull();
  });

  it("uses the next moment that exists when told to be lenient", () => {
    expect(
      localToInstantLenient("2027-03-14", "02:30", DETROIT).toISOString(),
    ).toBe("2027-03-14T07:30:00.000Z");
  });

  it("takes the earlier instant for a time the fall change repeats", () => {
    expect(localToInstant("2027-11-07", "01:30", DETROIT)?.toISOString()).toBe(
      "2027-11-07T05:30:00.000Z",
    );
  });

  it("reads an instant back as local date and clock time", () => {
    const instant = new Date("2027-01-16T02:30:00.000Z");

    expect(localDateOf(instant, DETROIT)).toBe("2027-01-15");
    expect(localTimeOf(instant, DETROIT)).toBe("21:30");
    expect(localMinutesOf(instant, DETROIT)).toBe(21 * 60 + 30);
  });

  it("does date arithmetic across a daylight-saving change and a leap day", () => {
    expect(addDays("2027-03-13", 1)).toBe("2027-03-14");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("numbers days of the week from Sunday", () => {
    expect(dayOfWeek("2027-01-03")).toBe(0);
    expect(dayOfWeek("2027-01-09")).toBe(6);
  });

  it("reads clock times with or without seconds", () => {
    expect(timeToMinutes("17:30")).toBe(1050);
    expect(timeToMinutes("17:30:00")).toBe(1050);
  });
});
