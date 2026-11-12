import { describe, expect, it } from "vitest";

import { formatInstant } from "./format-instant";
import { localToInstant } from "./zoned-time";

describe("formatInstant", () => {
  const instant = "2026-11-11T23:05:00.000Z";

  it("shows the location's wall clock, not the machine's", () => {
    expect(formatInstant(instant, "America/Chicago", "time")).toBe("5:05 PM");
    expect(formatInstant(instant, "Asia/Tokyo", "time")).toBe("8:05 AM");
    expect(formatInstant(instant, "America/Chicago")).toBe("Nov 11, 2026, 5:05 PM");
    expect(formatInstant(instant, "Asia/Tokyo", "date")).toBe("Nov 12, 2026");
  });

  it("follows a daylight saving change", () => {
    expect(formatInstant("2026-11-01T06:30:00.000Z", "America/Chicago", "time")).toBe("1:30 AM");
    expect(formatInstant("2026-11-01T07:30:00.000Z", "America/Chicago", "time")).toBe("1:30 AM");
    expect(formatInstant("2026-11-01T08:30:00.000Z", "America/Chicago", "time")).toBe("2:30 AM");
  });

  it("gives an empty string for a missing value", () => {
    expect(formatInstant(null, "UTC")).toBe("");
    expect(formatInstant(undefined, "UTC")).toBe("");
  });
});

describe("datetime-local input at the location", () => {
  it("reads the wall-clock value in the location's zone", () => {
    expect(localToInstant("2026-11-11", "17:05", "America/Chicago")?.toISOString()).toBe(
      "2026-11-11T23:05:00.000Z",
    );
  });

  it("has no instant for a time the clocks skip", () => {
    expect(localToInstant("2026-03-08", "02:30", "America/Chicago")).toBeNull();
  });
});
