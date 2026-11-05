import { describe, expect, it } from "vitest";

import { analyzeCoverage, type CoverageShift } from "./coverage-analyzer";
import { buildUnfilledDetail } from "./explanation-builder";
import { HOUR_MS } from "./test-builders";

function coverageShift(overrides: Partial<CoverageShift> = {}): CoverageShift {
  return {
    id: "shift-1",
    shiftDate: "2027-01-06",
    positionId: "server",
    positionName: "Server",
    restaurantAreaId: null,
    restaurantAreaName: null,
    requiredEmployeeCount: 1,
    assignedCount: 1,
    ...overrides,
  };
}

function analyze(
  shifts: CoverageShift[],
  employeeWeeks: Parameters<typeof analyzeCoverage>[0]["employeeWeeks"] = [],
) {
  return analyzeCoverage({
    shifts,
    employeeWeeks,
    overtimeThresholdMs: 40 * HOUR_MS,
  });
}

describe("coverage analysis", () => {
  it("reports a fully staffed schedule", () => {
    expect(analyze([coverageShift()])).toMatchObject({
      required: 1,
      filled: 1,
      open: 0,
      openShiftIds: [],
    });
  });

  it("reports one missing server", () => {
    expect(
      analyze([
        coverageShift(),
        coverageShift({ id: "shift-2", assignedCount: 0 }),
      ]),
    ).toMatchObject({ required: 2, filled: 1, open: 1, openShiftIds: ["shift-2"] });
  });

  it("reports multiple missing roles by position", () => {
    const result = analyze([
      coverageShift({ assignedCount: 0 }),
      coverageShift({
        id: "shift-2",
        positionId: "bartender",
        positionName: "Bartender",
        assignedCount: 0,
      }),
    ]);

    expect(result.byPosition.map((line) => [line.label, line.open])).toEqual([
      ["Bartender", 1],
      ["Server", 1],
    ]);
  });

  it("counts every slot of a shift needing more than one person", () => {
    expect(
      analyze([coverageShift({ requiredEmployeeCount: 3, assignedCount: 1 })]),
    ).toMatchObject({ required: 3, filled: 1, open: 2 });
  });

  it("doesn't count extra assignees toward other slots", () => {
    expect(
      analyze([
        coverageShift({ requiredEmployeeCount: 1, assignedCount: 2 }),
        coverageShift({ id: "shift-2", assignedCount: 0 }),
      ]),
    ).toMatchObject({ required: 2, filled: 1, open: 1 });
  });

  it("breaks coverage down by day and area", () => {
    const result = analyze([
      coverageShift({
        restaurantAreaId: "bar",
        restaurantAreaName: "Bar",
        assignedCount: 0,
      }),
      coverageShift({
        id: "shift-2",
        shiftDate: "2027-01-07",
        restaurantAreaId: "dining",
        restaurantAreaName: "Dining Room",
      }),
    ]);

    expect(result.byDay.map((line) => [line.label, line.filled])).toEqual([
      ["2027-01-06", 0],
      ["2027-01-07", 1],
    ]);
    expect(result.byArea.map((line) => [line.label, line.open])).toEqual([
      ["Bar", 1],
      ["Dining Room", 0],
    ]);
  });

  it("warns about overtime and hours against the employee's preferences", () => {
    const week = {
      employeeId: "a",
      displayName: "Jane Smith",
      weekStart: "2027-01-04",
      targetMs: null,
      minimumMs: null,
      maximumMs: null,
    };

    expect(
      analyze([], [{ ...week, scheduledMs: 41 * HOUR_MS }]).warnings.map(
        (warning) => warning.code,
      ),
    ).toEqual(["PROJECTED_OVERTIME"]);
    expect(
      analyze(
        [],
        [
          {
            ...week,
            scheduledMs: 30 * HOUR_MS,
            targetMs: 25 * HOUR_MS,
            maximumMs: 28 * HOUR_MS,
          },
        ],
      ).warnings.map((warning) => warning.code),
    ).toEqual(["OVER_TARGET_HOURS", "OVER_PREFERRED_MAXIMUM"]);
    expect(
      analyze([], [
        { ...week, scheduledMs: 10 * HOUR_MS, minimumMs: 20 * HOUR_MS },
      ]).warnings.map((warning) => warning.code),
    ).toEqual(["UNDER_PREFERRED_MINIMUM"]);
  });

  it("gives the same result for the same shifts in any order", () => {
    const shifts = [
      coverageShift({ id: "a", positionId: "z", positionName: "Zed", shiftDate: "2027-01-08" }),
      coverageShift({ id: "b", positionId: "y", positionName: "Yan", shiftDate: "2027-01-07" }),
    ];
    const forward = analyze(shifts);
    const backward = analyze([...shifts].reverse());

    expect(forward.byDay).toEqual(backward.byDay);
    expect(forward.byPosition).toEqual(backward.byPosition);
  });
});

describe("unfilled-shift explanations", () => {
  it("summarizes every reason with counts, largest first", () => {
    const detail = buildUnfilledDetail({
      shiftId: "shift-1",
      openSlots: 2,
      rejections: [
        ["POSITION_NOT_HELD"],
        ["POSITION_NOT_HELD", "AVAILABILITY_NOT_CONFIGURED"],
        ["APPROVED_TIME_OFF"],
      ],
    });

    expect(detail).toMatchObject({ openSlots: 2, candidatesConsidered: 3 });
    expect(detail.reasons.map((reason) => [reason.code, reason.employeeCount])).toEqual([
      ["POSITION_NOT_HELD", 2],
      ["APPROVED_TIME_OFF", 1],
      ["AVAILABILITY_NOT_CONFIGURED", 1],
    ]);
    expect(detail.summary).toContain("2 don't hold this position");
    expect(detail.summary).toContain("1 have approved time off");
  });

  it("explains a location with nobody to consider", () => {
    expect(
      buildUnfilledDetail({ shiftId: "s", openSlots: 1, rejections: [] }).summary,
    ).toMatch(/no other employees/i);
  });

  it("doesn't reveal employment status or restricted data", () => {
    const text = JSON.stringify(
      buildUnfilledDetail({
        shiftId: "s",
        openSlots: 1,
        rejections: [["EMPLOYEE_NOT_SCHEDULABLE"]],
      }),
    );

    expect(text).not.toMatch(/terminated|leave|suspended|wage|salary|disciplin/i);
  });
});
