import { describe, expect, it } from "vitest";

import {
  compareCandidates,
  fairnessCountsFor,
  scoreCandidate,
  softWarningsFor,
} from "./candidate-scorer";
import {
  at,
  context,
  employee,
  HOUR_MS,
  PERIOD,
  preferences,
  rules,
  scheduled,
  shift,
  TZ,
} from "./test-builders";

const WEDNESDAY = "2027-01-06";
const SATURDAY = "2027-01-09";
const dinner = shift(WEDNESDAY, "17:00", "21:00");

function score(overrides: {
  target?: typeof dinner;
  schedule?: Partial<ReturnType<typeof context>>;
  rule?: Parameters<typeof rules>[0];
  counts?: { weekend: number; closing: number };
  highestCounts?: { weekend: number; closing: number };
} = {}) {
  return scoreCandidate({
    shift: overrides.target ?? dinner,
    employee: employee(),
    context: context(overrides.schedule),
    rules: rules({ minimumRestHours: null, ...overrides.rule }),
    timeZone: TZ,
    counts: overrides.counts ?? { weekend: 0, closing: 0 },
    highestCounts: overrides.highestCounts ?? { weekend: 0, closing: 0 },
  });
}

const pointsFor = (result: ReturnType<typeof score>, code: string) =>
  result.reasons.find((reason) => reason.code === code)?.points;

describe("candidate scoring", () => {
  it("scores nothing with no preferences and no fairness difference", () => {
    expect(score()).toEqual({ score: 0, reasons: [] });
  });

  it("gives +20 below target and -10 at or above it", () => {
    const schedule = (assignments: ReturnType<typeof scheduled>[]) => ({
      preferences: preferences({ targetMs: 8 * HOUR_MS }),
      assignments,
    });

    expect(pointsFor(score({ schedule: schedule([]) }), "BELOW_TARGET_HOURS")).toBe(20);
    expect(
      pointsFor(
        score({ schedule: schedule([scheduled("2027-01-04", "09:00", "17:00")]) }),
        "AT_OR_ABOVE_TARGET_HOURS",
      ),
    ).toBe(-10);
  });

  it("ignores target hours when the rule is off", () => {
    expect(
      score({
        schedule: { preferences: preferences({ targetMs: 8 * HOUR_MS }) },
        rule: { preferTargetHours: false },
      }).score,
    ).toBe(0);
  });

  it("gives a below-target candidate a win over an above-target one", () => {
    const under = score({
      schedule: { preferences: preferences({ targetMs: 8 * HOUR_MS }) },
    });
    const over = score({
      schedule: {
        preferences: preferences({ targetMs: 8 * HOUR_MS }),
        assignments: [scheduled("2027-01-04", "09:00", "18:00")],
      },
    });

    expect(under.score).toBeGreaterThan(over.score);
  });

  it("gives -50 for crossing the overtime threshold, only when avoiding overtime", () => {
    const schedule = {
      assignments: [
        scheduled("2027-01-04", "09:00", "18:00"),
        scheduled("2027-01-05", "09:00", "18:00"),
      ],
    };

    expect(
      pointsFor(
        score({ schedule, rule: { weeklyOvertimeThreshold: "20.00" } }),
        "CROSSES_OVERTIME",
      ),
    ).toBe(-50);
    expect(
      pointsFor(
        score({
          schedule,
          rule: { weeklyOvertimeThreshold: "20.00", avoidOvertime: false },
        }),
        "CROSSES_OVERTIME",
      ),
    ).toBeUndefined();
    expect(
      pointsFor(
        score({ schedule, rule: { weeklyOvertimeThreshold: "22.00" } }),
        "CROSSES_OVERTIME",
      ),
    ).toBeUndefined();
  });

  it("gives +12 inside a preferred window and -6 outside it", () => {
    const window = (start: string, end: string) => ({
      preferences: preferences({ preferredShiftStart: start, preferredShiftEnd: end }),
    });

    expect(pointsFor(score({ schedule: window("16:00", "20:00") }), "PREFERRED_TIME")).toBe(12);
    expect(pointsFor(score({ schedule: window("08:00", "12:00") }), "PREFERRED_TIME")).toBe(-6);
    expect(pointsFor(score({ schedule: window("22:00", "18:00") }), "PREFERRED_TIME")).toBe(12);
  });

  it("scores weekend, opening and closing preferences only when they apply", () => {
    const opening = shift(SATURDAY, "09:00", "15:00");
    const closing = shift(WEDNESDAY, "18:00", "23:00");

    expect(
      pointsFor(
        score({
          target: opening,
          schedule: { preferences: preferences({ preferWeekends: true }) },
        }),
        "PREFERS_WEEKENDS",
      ),
    ).toBe(12);
    expect(
      pointsFor(
        score({
          target: opening,
          schedule: { preferences: preferences({ preferOpening: false }) },
        }),
        "PREFERS_OPENING",
      ),
    ).toBe(-6);
    expect(
      pointsFor(
        score({
          target: closing,
          schedule: { preferences: preferences({ preferClosing: true }) },
        }),
        "PREFERS_CLOSING",
      ),
    ).toBe(12);
    expect(
      score({ schedule: { preferences: preferences({ preferWeekends: true }) } }).score,
    ).toBe(0);
  });

  it("gives +8 per shift fewer on a weekend, only when balancing", () => {
    const target = shift(SATURDAY, "12:00", "17:00");
    const counts = { weekend: 1, closing: 0 };
    const highestCounts = { weekend: 3, closing: 0 };

    expect(
      pointsFor(score({ target, counts, highestCounts }), "WEEKEND_FAIRNESS"),
    ).toBe(16);
    expect(
      pointsFor(
        score({ target, counts, highestCounts, rule: { balanceWeekendShifts: false } }),
        "WEEKEND_FAIRNESS",
      ),
    ).toBeUndefined();
    expect(
      pointsFor(score({ counts, highestCounts }), "WEEKEND_FAIRNESS"),
    ).toBeUndefined();
  });

  it("gives +8 per shift fewer on a closing shift, including one past midnight", () => {
    const counts = { weekend: 0, closing: 0 };
    const highestCounts = { weekend: 0, closing: 2 };

    expect(
      pointsFor(
        score({ target: shift(WEDNESDAY, "20:00", "01:00"), counts, highestCounts }),
        "CLOSING_FAIRNESS",
      ),
    ).toBe(16);
    expect(
      pointsFor(
        score({ target: shift(WEDNESDAY, "18:00", "22:00"), counts, highestCounts }),
        "CLOSING_FAIRNESS",
      ),
    ).toBe(16);
  });

  it("gives -18 for short rest when rest is soft, and nothing when it's hard", () => {
    const schedule = { assignments: [scheduled("2027-01-07", "02:00", "08:00")] };

    expect(
      pointsFor(score({ schedule, rule: { minimumRestHours: "8.00" } }), "SHORT_REST"),
    ).toBe(-18);
    expect(
      pointsFor(
        score({ schedule, rule: { minimumRestHours: "8.00", minimumRestHard: true } }),
        "SHORT_REST",
      ),
    ).toBeUndefined();
  });

  it("gives -24 for overlapping pending time off", () => {
    expect(
      pointsFor(
        score({
          schedule: {
            pendingTimeOff: [
              { startAt: at(WEDNESDAY, "18:00"), endAt: at(WEDNESDAY, "19:00") },
            ],
          },
        }),
        "PENDING_TIME_OFF",
      ),
    ).toBe(-24);
  });

  it("gives -12 per day past a soft weekly-day preference", () => {
    expect(
      pointsFor(
        score({
          schedule: {
            preferences: preferences({ maximumDaysPerWeek: 1 }),
            assignments: [
              scheduled("2027-01-04", "09:00", "10:00"),
              scheduled("2027-01-05", "09:00", "10:00"),
            ],
          },
        }),
        "WEEKLY_DAYS_PREFERENCE",
      ),
    ).toBe(-24);
  });

  it("gives -15 per day past a soft consecutive-day preference", () => {
    expect(
      pointsFor(
        score({
          schedule: {
            preferences: preferences({ maximumConsecutiveDays: 2 }),
            assignments: [
              scheduled("2027-01-04", "09:00", "10:00"),
              scheduled("2027-01-05", "09:00", "10:00"),
            ],
          },
        }),
        "CONSECUTIVE_DAYS_PREFERENCE",
      ),
    ).toBe(-15);
  });

  it("uses a non-hard location rule when the employee states no preference", () => {
    expect(
      pointsFor(
        score({
          schedule: { assignments: [scheduled("2027-01-04", "09:00", "10:00")] },
          rule: { maximumDaysPerWeek: 1 },
        }),
        "WEEKLY_DAYS_PREFERENCE",
      ),
    ).toBe(-12);
  });

  it("totals its reasons, so the explanation matches the score", () => {
    const result = score({
      schedule: {
        preferences: preferences({
          targetMs: 8 * HOUR_MS,
          preferredShiftStart: "16:00",
          preferredShiftEnd: "20:00",
        }),
      },
    });

    expect(result.score).toBe(32);
    expect(result.reasons.map((reason) => reason.points)).toEqual([20, 12]);
  });

  it("has no input that could carry compensation", () => {
    expect(JSON.stringify(score())).not.toMatch(/wage|rate|salary|compensation/i);
  });
});

describe("candidate ordering", () => {
  const candidate = (score: number, employeeNumber: string, id: string) => ({
    score,
    employee: { employeeNumber, id },
  });

  it("puts the highest score first", () => {
    expect(
      compareCandidates(candidate(10, "2", "a"), candidate(20, "1", "b")),
    ).toBeGreaterThan(0);
  });

  it("breaks a tie by employee number, then UUID", () => {
    expect(
      compareCandidates(candidate(10, "E-1", "z"), candidate(10, "E-2", "a")),
    ).toBeLessThan(0);
    expect(
      compareCandidates(candidate(10, "E-1", "a"), candidate(10, "E-1", "b")),
    ).toBeLessThan(0);
  });

  it("orders employee numbers by code point, not by locale", () => {
    expect(
      compareCandidates(candidate(1, "Z", "a"), candidate(1, "a", "b")),
    ).toBeLessThan(0);
  });
});

describe("fairness lookback", () => {
  it("counts only weekend and closing shifts in this period", () => {
    expect(
      fairnessCountsFor(
        context({
          assignments: [
            scheduled(SATURDAY, "12:00", "17:00"),
            scheduled("2027-01-10", "18:00", "23:00"),
            scheduled(WEDNESDAY, "09:00", "12:00"),
            scheduled("2027-01-02", "12:00", "17:00", "another-period"),
          ],
        }),
        PERIOD,
        TZ,
      ),
    ).toEqual({ weekend: 2, closing: 1 });
  });
});

describe("soft warnings", () => {
  it("warn without any hard consequence", () => {
    const warnings = softWarningsFor({
      shift: dinner,
      context: context({
        pendingTimeOff: [
          { startAt: at(WEDNESDAY, "18:00"), endAt: at(WEDNESDAY, "19:00") },
        ],
        assignments: [
          scheduled("2027-01-04", "09:00", "20:00"),
          scheduled("2027-01-05", "09:00", "20:00"),
          scheduled("2027-01-07", "01:00", "03:00"),
        ],
        preferences: preferences({
          maximumDaysPerWeek: 2,
          maximumConsecutiveDays: 2,
        }),
      }),
      rules: rules({ weeklyOvertimeThreshold: "20.00" }),
    });

    expect(warnings.map((warning) => warning.code)).toEqual([
      "PENDING_TIME_OFF",
      "PROJECTED_OVERTIME",
      "SHORT_REST",
      "WEEKLY_DAYS_PREFERENCE",
      "CONSECUTIVE_DAYS_PREFERENCE",
    ]);
  });
});
