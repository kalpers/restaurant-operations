import { describe, expect, it } from "vitest";

import {
  allocateOvertime,
  entryFlags,
  hoursToSeconds,
  matchShift,
  overtimeState,
  workedSeconds,
} from "./time-clock";

const at = (iso: string) => new Date(iso);
const H = 3600;

describe("workedSeconds", () => {
  it("subtracts unpaid breaks and keeps paid ones", () => {
    const entry = { clockInAt: at("2026-11-10T16:00:00Z"), clockOutAt: at("2026-11-10T23:00:00Z") };

    expect(
      workedSeconds(entry, [
        { startedAt: at("2026-11-10T19:00:00Z"), endedAt: at("2026-11-10T19:30:00Z"), paid: false },
        { startedAt: at("2026-11-10T21:00:00Z"), endedAt: at("2026-11-10T21:10:00Z"), paid: true },
      ]),
    ).toBe(6.5 * H);
  });

  it("runs past midnight and counts to the second", () => {
    expect(
      workedSeconds({ clockInAt: at("2026-11-10T22:00:00Z"), clockOutAt: at("2026-11-11T02:00:01.400Z") }, []),
    ).toBe(4 * H + 1);
  });

  it("ends an open entry and an open break at now", () => {
    const now = at("2026-11-10T20:00:00Z");

    expect(
      workedSeconds(
        { clockInAt: at("2026-11-10T16:00:00Z"), clockOutAt: null },
        [{ startedAt: at("2026-11-10T19:00:00Z"), endedAt: null, paid: false }],
        now,
      ),
    ).toBe(3 * H);
  });
});

describe("matchShift", () => {
  const base = { positionId: "p1", locationId: "l1" };
  const clockIn = { at: at("2026-11-10T16:05:00Z"), ...base };

  it("picks the closest start within 60 minutes for the same position and location", () => {
    expect(
      matchShift(clockIn, [
        { assignmentId: "a", ...base, startAt: at("2026-11-10T15:10:00Z") },
        { assignmentId: "b", ...base, startAt: at("2026-11-10T16:00:00Z") },
        { assignmentId: "c", positionId: "p2", locationId: "l1", startAt: at("2026-11-10T16:05:00Z") },
        { assignmentId: "d", positionId: "p1", locationId: "l2", startAt: at("2026-11-10T16:05:00Z") },
      ]),
    ).toBe("b");
  });

  it("includes the window edge and breaks ties by assignment UUID", () => {
    expect(
      matchShift(clockIn, [
        { assignmentId: "z", ...base, startAt: at("2026-11-10T17:05:00Z") },
        { assignmentId: "m", ...base, startAt: at("2026-11-10T15:05:00Z") },
      ]),
    ).toBe("m");
  });

  it("returns null when nothing is within the window", () => {
    expect(matchShift(clockIn, [{ assignmentId: "a", ...base, startAt: at("2026-11-10T17:06:00Z") }])).toBeNull();
  });
});

describe("allocateOvertime", () => {
  const entry = (id: string, day: number, hours: number) => ({
    id,
    clockInAt: at(`2026-11-${String(day).padStart(2, "0")}T16:00:00Z`),
    workedSeconds: hours * H,
  });

  it("has no overtime below or at the threshold", () => {
    const split = allocateOvertime([entry("a", 9, 20), entry("b", 10, 20)], 40 * H);

    expect(split.get("b")).toEqual({ regularSeconds: 20 * H, overtimeSeconds: 0 });
  });

  it("splits the entry that crosses the threshold and makes later work overtime", () => {
    const split = allocateOvertime(
      [entry("c", 12, 8), entry("a", 9, 30), entry("b", 10, 6)],
      40 * H,
    );

    expect(split.get("a")).toEqual({ regularSeconds: 30 * H, overtimeSeconds: 0 });
    expect(split.get("b")).toEqual({ regularSeconds: 6 * H, overtimeSeconds: 0 });
    expect(split.get("c")).toEqual({ regularSeconds: 4 * H, overtimeSeconds: 4 * H });
  });

  it("orders same-instant entries by UUID", () => {
    const sameStart = at("2026-11-09T16:00:00Z");
    const split = allocateOvertime(
      [
        { id: "y", clockInAt: sameStart, workedSeconds: 10 * H },
        { id: "x", clockInAt: sameStart, workedSeconds: 10 * H },
      ],
      15 * H,
    );

    expect(split.get("x")).toEqual({ regularSeconds: 10 * H, overtimeSeconds: 0 });
    expect(split.get("y")).toEqual({ regularSeconds: 5 * H, overtimeSeconds: 5 * H });
  });
});

describe("overtimeState", () => {
  it.each([
    [35.99, "NONE"],
    [36, "APPROACHING"],
    [40, "APPROACHING"],
    [40.01, "OVERTIME"],
  ])("%s hours is %s", (hours, state) => {
    expect(overtimeState(Math.round(hours * H), 40 * H)).toBe(state);
  });
});

describe("hoursToSeconds", () => {
  it("parses the rules' hour strings exactly", () => {
    expect(hoursToSeconds("40.00")).toBe(40 * H);
    expect(hoursToSeconds("37.5")).toBe(37.5 * H);
    expect(hoursToSeconds("0.01")).toBe(36);
  });
});

describe("entryFlags", () => {
  const shift = { startAt: at("2026-11-10T16:00:00Z"), endAt: at("2026-11-10T22:00:00Z") };

  it("flags late clock-in and early clock-out beyond the grace", () => {
    expect(
      entryFlags({ clockInAt: at("2026-11-10T16:06:00Z"), clockOutAt: at("2026-11-10T21:54:00Z") }, shift, 5),
    ).toEqual({ unscheduled: false, late: true, earlyOut: true, long: false });
    expect(
      entryFlags({ clockInAt: at("2026-11-10T16:05:00Z"), clockOutAt: at("2026-11-10T21:55:00Z") }, shift, 5),
    ).toEqual({ unscheduled: false, late: false, earlyOut: false, long: false });
  });

  it("flags unscheduled and over-16-hour entries", () => {
    expect(
      entryFlags({ clockInAt: at("2026-11-10T06:00:00Z"), clockOutAt: at("2026-11-10T22:00:01Z") }, null, 5),
    ).toEqual({ unscheduled: true, late: false, earlyOut: false, long: true });
  });
});

// Phase 20 policy 19 (D18): daily overtime first, then weekly on what stayed regular.
describe("daily and weekly overtime together", () => {
  const H = 3600;
  const day = (date: string, hour: number, hours: number, id = `${date}-${hour}`) => ({
    id,
    businessDate: date,
    clockInAt: new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`),
    workedSeconds: hours * H,
  });

  it("counts hours past the daily line as overtime, latest work first", () => {
    const split = allocateOvertime([day("2026-11-09", 8, 6, "a"), day("2026-11-09", 15, 4, "b")], 40 * H, 8 * H);

    expect(split.get("a")).toEqual({ regularSeconds: 6 * H, overtimeSeconds: 0 });
    expect(split.get("b")).toEqual({ regularSeconds: 2 * H, overtimeSeconds: 2 * H });
  });

  it("never counts an hour twice: weekly overtime uses only the hours still regular", () => {
    // Five 10-hour days: 2 h daily overtime each (10 h), 40 h regular, so no weekly overtime.
    const week = ["09", "10", "11", "12", "13"].map((d) => day(`2026-11-${d}`, 8, 10));
    const split = allocateOvertime(week, 40 * H, 8 * H);
    const total = [...split.values()].reduce((sum, value) => sum + value.overtimeSeconds, 0);

    expect(total).toBe(10 * H);

    // A sixth day of 8 hours is all weekly overtime (40 regular hours were used).
    const six = allocateOvertime([...week, day("2026-11-14", 8, 8, "sat")], 40 * H, 8 * H);

    expect(six.get("sat")).toEqual({ regularSeconds: 0, overtimeSeconds: 8 * H });
  });

  it("is weekly only when the daily line is off", () => {
    const split = allocateOvertime([day("2026-11-09", 8, 12, "a")], 40 * H, null);

    expect(split.get("a")).toEqual({ regularSeconds: 12 * H, overtimeSeconds: 0 });
  });

  it("warns near and past the daily line", () => {
    expect(overtimeState(7.5 * H, 40 * H, { todaySeconds: 7.5 * H, thresholdSeconds: 8 * H })).toBe("APPROACHING");
    expect(overtimeState(9 * H, 40 * H, { todaySeconds: 9 * H, thresholdSeconds: 8 * H })).toBe("OVERTIME");
    expect(overtimeState(6 * H, 40 * H, { todaySeconds: 6 * H, thresholdSeconds: 8 * H })).toBe("NONE");
  });
});
