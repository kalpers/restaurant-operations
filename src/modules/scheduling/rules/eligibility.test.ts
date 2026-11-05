import { describe, expect, it } from "vitest";

import { evaluateEligibility } from "./eligibility";
import {
  at,
  context,
  employee,
  LOCATION,
  POSITION,
  rules,
  scheduled,
  shift,
  TZ,
} from "./test-builders";

const WEDNESDAY = "2027-01-06";
const dinner = shift(WEDNESDAY, "17:00", "22:00");

function evaluate(overrides: {
  target?: typeof dinner;
  facts?: Partial<ReturnType<typeof employee>>;
  schedule?: Partial<ReturnType<typeof context>>;
  rule?: Parameters<typeof rules>[0];
} = {}) {
  return evaluateEligibility({
    shift: overrides.target ?? dinner,
    employee: employee(overrides.facts),
    context: context(overrides.schedule),
    rules: rules(overrides.rule),
    timeZone: TZ,
  });
}

describe("hard eligibility", () => {
  it("accepts an active, located, qualified, available employee", () => {
    const result = evaluate();

    expect(result.eligible).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it.each(["TERMINATED", "ON_LEAVE", "SUSPENDED"])(
    "refuses %s with one generic code that doesn't reveal the status",
    (status) => {
      const result = evaluate({ facts: { employmentStatus: status } });

      expect(result.violations).toEqual(["EMPLOYEE_NOT_SCHEDULABLE"]);
      expect(JSON.stringify(result)).not.toContain(status);
    },
  );

  it("refuses the wrong location", () => {
    expect(
      evaluate({
        target: shift(WEDNESDAY, "17:00", "22:00", { locationId: "another" }),
      }).violations,
    ).toContain("LOCATION_NOT_ELIGIBLE");
  });

  it("refuses a location assignment that has ended or hasn't started", () => {
    expect(
      evaluate({
        facts: {
          locations: [
            { locationId: LOCATION, effectiveFrom: "2020-01-01", effectiveTo: "2027-01-05" },
          ],
        },
      }).violations,
    ).toEqual(["LOCATION_NOT_ELIGIBLE"]);
    expect(
      evaluate({
        facts: {
          locations: [
            { locationId: LOCATION, effectiveFrom: "2027-01-07", effectiveTo: null },
          ],
        },
      }).violations,
    ).toEqual(["LOCATION_NOT_ELIGIBLE"]);
  });

  it("counts an end date as inclusive", () => {
    expect(
      evaluate({
        facts: {
          locations: [
            { locationId: LOCATION, effectiveFrom: "2020-01-01", effectiveTo: WEDNESDAY },
          ],
          positions: [
            {
              positionId: POSITION,
              locationId: LOCATION,
              effectiveFrom: "2020-01-01",
              effectiveTo: WEDNESDAY,
            },
          ],
        },
      }).eligible,
    ).toBe(true);
  });

  it("refuses someone with no employee position, whatever their login can do", () => {
    // The evaluator has no input for security roles, so one can't substitute.
    expect(evaluate({ facts: { positions: [] } }).violations).toEqual([
      "POSITION_NOT_HELD",
    ]);
  });

  it("refuses a position that takes effect after the shift", () => {
    expect(
      evaluate({
        facts: {
          positions: [
            {
              positionId: POSITION,
              locationId: LOCATION,
              effectiveFrom: "2027-02-01",
              effectiveTo: null,
            },
          ],
        },
      }).violations,
    ).toEqual(["POSITION_NOT_HELD"]);
  });

  it("refuses a position held at a different location", () => {
    expect(
      evaluate({
        facts: {
          positions: [
            {
              positionId: POSITION,
              locationId: "another",
              effectiveFrom: "2020-01-01",
              effectiveTo: null,
            },
          ],
        },
      }).violations,
    ).toEqual(["POSITION_NOT_HELD"]);
  });

  it("refuses approved time off that overlaps", () => {
    expect(
      evaluate({
        schedule: {
          approvedTimeOff: [
            { startAt: at(WEDNESDAY, "12:00"), endAt: at(WEDNESDAY, "18:00") },
          ],
        },
      }).violations,
    ).toEqual(["APPROVED_TIME_OFF"]);
  });

  it("allows time off ending exactly when the shift starts", () => {
    expect(
      evaluate({
        schedule: {
          approvedTimeOff: [
            { startAt: at(WEDNESDAY, "12:00"), endAt: at(WEDNESDAY, "17:00") },
          ],
        },
      }).eligible,
    ).toBe(true);
  });

  it("doesn't treat pending time off as a hard conflict", () => {
    expect(
      evaluate({
        schedule: {
          pendingTimeOff: [
            { startAt: at(WEDNESDAY, "12:00"), endAt: at(WEDNESDAY, "18:00") },
          ],
        },
      }).eligible,
    ).toBe(true);
  });

  it("refuses an unavailable window", () => {
    expect(
      evaluate({
        schedule: {
          recurring: [],
          exceptions: [
            {
              locationId: null,
              exceptionDate: WEDNESDAY,
              startTime: null,
              endTime: null,
              availabilityType: "UNAVAILABLE",
            },
          ],
        },
      }).violations,
    ).toEqual(["AVAILABILITY_UNAVAILABLE"]);
  });

  describe("overlap", () => {
    it("refuses an overlapping shift", () => {
      expect(
        evaluate({
          schedule: { assignments: [scheduled(WEDNESDAY, "20:00", "23:00")] },
        }).violations,
      ).toEqual(["SHIFT_OVERLAP"]);
    });

    it("allows back-to-back shifts", () => {
      expect(
        evaluate({
          schedule: { assignments: [scheduled(WEDNESDAY, "22:00", "23:30")] },
          rule: { minimumRestHours: null },
        }).eligible,
      ).toBe(true);
    });

    it("sees an overlap across midnight even though the dates differ", () => {
      expect(
        evaluate({
          target: shift("2027-01-07", "01:00", "03:00"),
          schedule: { assignments: [scheduled(WEDNESDAY, "22:00", "02:00")] },
        }).violations,
      ).toEqual(["SHIFT_OVERLAP"]);
    });
  });

  describe("configured hard limits", () => {
    it("refuses past the maximum weekly hours", () => {
      expect(
        evaluate({
          schedule: { assignments: [scheduled("2027-01-04", "10:00", "20:00")] },
          rule: { maximumWeeklyHours: "14.00", minimumRestHours: null },
        }).violations,
      ).toEqual(["HARD_WEEKLY_HOURS"]);
    });

    it("allows exactly the maximum weekly hours", () => {
      expect(
        evaluate({
          schedule: { assignments: [scheduled("2027-01-04", "10:00", "20:00")] },
          rule: { maximumWeeklyHours: "15.00" },
        }).eligible,
      ).toBe(true);
    });

    it("counts days per week only when the limit is hard", () => {
      const schedule = {
        assignments: [
          scheduled("2027-01-04", "17:00", "22:00"),
          scheduled("2027-01-05", "17:00", "22:00"),
        ],
      };

      expect(
        evaluate({
          schedule,
          rule: { maximumDaysPerWeek: 2, maximumDaysHard: true },
        }).violations,
      ).toEqual(["HARD_WEEKLY_DAYS"]);
      expect(
        evaluate({ schedule, rule: { maximumDaysPerWeek: 2 } }).eligible,
      ).toBe(true);
    });

    it("counts a run of days across a week boundary", () => {
      expect(
        evaluate({
          target: shift("2027-01-04", "17:00", "22:00"),
          schedule: {
            assignments: [
              scheduled("2027-01-02", "17:00", "22:00"),
              scheduled("2027-01-03", "17:00", "22:00"),
            ],
          },
          rule: { maximumConsecutiveDays: 2, maximumConsecutiveHard: true },
        }).violations,
      ).toEqual(["HARD_CONSECUTIVE_DAYS"]);
    });

    it("refuses short rest only when rest is hard", () => {
      const schedule = {
        assignments: [scheduled("2027-01-07", "02:00", "10:00")],
      };

      expect(
        evaluate({
          schedule,
          rule: { minimumRestHours: "8.00", minimumRestHard: true },
        }).violations,
      ).toEqual(["HARD_MINIMUM_REST"]);
      expect(
        evaluate({ schedule, rule: { minimumRestHours: "8.00" } }).eligible,
      ).toBe(true);
    });

    it("measures rest by real instants across a daylight-saving change", () => {
      // 23:00 Saturday to 07:00 Sunday looks like 8 hours, but the clock jumps forward.
      expect(
        evaluate({
          target: shift("2027-03-14", "07:00", "12:00"),
          schedule: { assignments: [scheduled("2027-03-13", "17:00", "23:00")] },
          rule: { minimumRestHours: "8.00", minimumRestHard: true },
        }).violations,
      ).toEqual(["HARD_MINIMUM_REST"]);
    });
  });

  it("reports every failure at once, for the unfilled explanation", () => {
    const result = evaluate({
      facts: { employmentStatus: "SUSPENDED", positions: [] },
      schedule: { recurring: [] },
    });

    expect(result.violations).toEqual([
      "EMPLOYEE_NOT_SCHEDULABLE",
      "POSITION_NOT_HELD",
      "AVAILABILITY_NOT_CONFIGURED",
    ]);
    expect(
      result.checks.filter((check) => !check.passed).map((check) => check.code),
    ).toEqual(["SCHEDULABLE", "POSITION", "AVAILABILITY"]);
  });
});
