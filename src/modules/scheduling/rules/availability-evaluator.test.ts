import { describe, expect, it } from "vitest";

import { evaluateAvailability, type AvailabilityException } from "./availability-evaluator";
import { LOCATION, recurring, shift, TZ } from "./test-builders";

// 2027-01-05 is a Tuesday (day 2).
const TUESDAY = "2027-01-05";
const dinner = shift(TUESDAY, "17:00", "22:00");

function exception(
  overrides: Partial<AvailabilityException> = {},
): AvailabilityException {
  return {
    locationId: null,
    exceptionDate: TUESDAY,
    startTime: null,
    endTime: null,
    availabilityType: "UNAVAILABLE",
    ...overrides,
  };
}

function evaluate(
  input: {
    target?: typeof dinner;
    recurring?: Parameters<typeof evaluateAvailability>[0]["recurring"];
    exceptions?: Parameters<typeof evaluateAvailability>[0]["exceptions"];
  } = {},
) {
  return evaluateAvailability({
    shift: input.target ?? dinner,
    recurring: input.recurring ?? [],
    exceptions: input.exceptions ?? [],
    timeZone: TZ,
  });
}

describe("availability evaluation", () => {
  it("is available when a recurring window covers the whole shift", () => {
    expect(evaluate({ recurring: [recurring(2, "16:00", "23:00")] })).toBe(
      "AVAILABLE",
    );
  });

  it("treats missing availability as not configured, never as available", () => {
    expect(evaluate()).toBe("AVAILABILITY_NOT_CONFIGURED");
  });

  it("keeps explicit unavailability distinct from missing data", () => {
    expect(
      evaluate({ recurring: [recurring(2, "16:00", "23:00", "UNAVAILABLE")] }),
    ).toBe("AVAILABILITY_UNAVAILABLE");
  });

  it("doesn't accept a partial window that leaves part of the shift uncovered", () => {
    expect(evaluate({ recurring: [recurring(2, "17:00", "20:00")] })).toBe(
      "AVAILABILITY_NOT_COVERED",
    );
  });

  it("reports not covered when the day is configured but at another time", () => {
    expect(evaluate({ recurring: [recurring(2, "08:00", "12:00")] })).toBe(
      "AVAILABILITY_NOT_COVERED",
    );
  });

  it("reports not configured when only other days have records", () => {
    expect(evaluate({ recurring: [recurring(3, "16:00", "23:00")] })).toBe(
      "AVAILABILITY_NOT_CONFIGURED",
    );
  });

  it("joins adjacent windows to cover a shift", () => {
    expect(
      evaluate({
        recurring: [recurring(2, "16:00", "19:00"), recurring(2, "19:00", "23:00")],
      }),
    ).toBe("AVAILABLE");
  });

  it("ignores a record outside its effective dates", () => {
    expect(
      evaluate({
        recurring: [
          recurring(2, "16:00", "23:00", "AVAILABLE", {
            effectiveFrom: "2027-02-01",
          }),
        ],
      }),
    ).toBe("AVAILABILITY_NOT_CONFIGURED");
    expect(
      evaluate({
        recurring: [
          recurring(2, "16:00", "23:00", "AVAILABLE", {
            effectiveTo: "2027-01-04",
          }),
        ],
      }),
    ).toBe("AVAILABILITY_NOT_CONFIGURED");
  });

  it("applies a location-specific record only at that location", () => {
    expect(
      evaluate({
        recurring: [
          recurring(2, "16:00", "23:00", "AVAILABLE", {
            locationId: "another-location",
          }),
        ],
      }),
    ).toBe("AVAILABILITY_NOT_CONFIGURED");
    expect(
      evaluate({
        recurring: [
          recurring(2, "16:00", "23:00", "AVAILABLE", { locationId: LOCATION }),
        ],
      }),
    ).toBe("AVAILABLE");
  });

  describe("exception precedence", () => {
    it("recurring AVAILABLE plus an UNAVAILABLE exception is unavailable", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "16:00", "23:00")],
          exceptions: [exception()],
        }),
      ).toBe("AVAILABILITY_UNAVAILABLE");
    });

    it("recurring UNAVAILABLE plus an AVAILABLE exception is available", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "00:00", "23:59", "UNAVAILABLE")],
          exceptions: [exception({ availabilityType: "AVAILABLE" })],
        }),
      ).toBe("AVAILABLE");
    });

    it("an exception with no recurring record still decides the time it covers", () => {
      expect(
        evaluate({
          exceptions: [
            exception({
              availabilityType: "AVAILABLE",
              startTime: "16:00",
              endTime: "23:00",
            }),
          ],
        }),
      ).toBe("AVAILABLE");
    });

    it("a partial exception leaves recurring availability to cover the rest", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "19:00", "23:00")],
          exceptions: [
            exception({
              availabilityType: "AVAILABLE",
              startTime: "17:00",
              endTime: "19:00",
            }),
          ],
        }),
      ).toBe("AVAILABLE");
      expect(
        evaluate({
          recurring: [recurring(2, "20:00", "23:00")],
          exceptions: [
            exception({
              availabilityType: "AVAILABLE",
              startTime: "17:00",
              endTime: "19:00",
            }),
          ],
        }),
      ).toBe("AVAILABILITY_NOT_COVERED");
    });

    it("a partial UNAVAILABLE exception rules the shift out", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "16:00", "23:00")],
          exceptions: [exception({ startTime: "20:00", endTime: "21:00" })],
        }),
      ).toBe("AVAILABILITY_UNAVAILABLE");
    });

    it("an exception outside the shift's time doesn't affect it", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "16:00", "23:00")],
          exceptions: [exception({ startTime: "08:00", endTime: "09:00" })],
        }),
      ).toBe("AVAILABLE");
    });

    it("an exception on another date doesn't apply", () => {
      expect(
        evaluate({
          recurring: [recurring(2, "16:00", "23:00")],
          exceptions: [exception({ exceptionDate: "2027-01-12" })],
        }),
      ).toBe("AVAILABLE");
    });
  });

  describe("past midnight", () => {
    const overnightShift = shift(TUESDAY, "20:00", "02:00");

    it("an overnight window covers an overnight shift", () => {
      expect(
        evaluate({
          target: overnightShift,
          recurring: [recurring(2, "18:00", "03:00")],
        }),
      ).toBe("AVAILABLE");
    });

    it("two days' windows cover a shift across midnight", () => {
      expect(
        evaluate({
          target: overnightShift,
          recurring: [recurring(2, "18:00", "00:00"), recurring(3, "00:00", "03:00")],
        }),
      ).toBe("AVAILABLE");
    });

    it("only the first day's window leaves the shift uncovered", () => {
      expect(
        evaluate({
          target: overnightShift,
          recurring: [recurring(2, "18:00", "00:00")],
        }),
      ).toBe("AVAILABILITY_NOT_COVERED");
    });

    it("yesterday's overnight window can cover this morning's shift", () => {
      expect(
        evaluate({
          target: shift("2027-01-06", "00:30", "02:00"),
          recurring: [recurring(2, "18:00", "03:00")],
        }),
      ).toBe("AVAILABLE");
    });

    it("an exception on the next date applies to the part past midnight", () => {
      expect(
        evaluate({
          target: overnightShift,
          recurring: [recurring(2, "18:00", "03:00")],
          exceptions: [exception({ exceptionDate: "2027-01-06" })],
        }),
      ).toBe("AVAILABILITY_UNAVAILABLE");
    });

    it("a shift ending exactly at midnight doesn't touch the next date", () => {
      expect(
        evaluate({
          target: shift(TUESDAY, "20:00", "00:00"),
          recurring: [recurring(2, "18:00", "00:00")],
          exceptions: [exception({ exceptionDate: "2027-01-06" })],
        }),
      ).toBe("AVAILABLE");
    });
  });

  it("handles a whole-day window on a daylight-saving date", () => {
    // 2027-03-14 is a Sunday when the clocks jump from 02:00 to 03:00.
    expect(
      evaluate({
        target: shift("2027-03-14", "01:00", "04:00"),
        recurring: [recurring(0, "00:00", "12:00")],
      }),
    ).toBe("AVAILABLE");
  });
});
