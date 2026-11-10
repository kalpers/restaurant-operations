import { describe, expect, it } from "vitest";

import { localToInstant } from "@/shared/time/zoned-time";

import {
  assignLanes,
  axisWindow,
  barPlacement,
  ceilToLocalHour,
  floorToLocalHour,
  formatDuration,
  hourlyHeadcount,
  hourTicks,
  minutesBetween,
  openSlots,
  POSITION_COLOR_COUNT,
  positionColorIndex,
  sortEmployees,
  sortPositions,
} from "./timeline-layout";

const ZONE = "America/Detroit";
const DAY = "2030-01-12";

function at(date: string, time: string, zone = ZONE): number {
  const instant = localToInstant(date, time, zone);

  if (!instant) {
    throw new Error(`No such local time ${date} ${time}`);
  }

  return Number(instant);
}

describe("axisWindow", () => {
  it("is 06:00 to the next midnight when nothing is earlier or later", () => {
    const window = axisWindow(DAY, ZONE, [
      { startMs: at(DAY, "11:00"), endMs: at(DAY, "17:00") },
    ]);

    expect(window).toEqual({
      startMs: at(DAY, "06:00"),
      endMs: at("2030-01-13", "00:00"),
    });
  });

  it("is the minimum on an empty day", () => {
    const window = axisWindow(DAY, ZONE, []);

    expect(hourTicks(window, ZONE)).toHaveLength(18);
  });

  it("widens to the hour before an early start", () => {
    const window = axisWindow(DAY, ZONE, [
      { startMs: at(DAY, "04:30"), endMs: at(DAY, "12:00") },
    ]);

    expect(window.startMs).toBe(at(DAY, "04:00"));
  });

  it("widens past midnight for an overnight shift ending 02:00 the next day", () => {
    const window = axisWindow(DAY, ZONE, [
      { startMs: at(DAY, "18:00"), endMs: at("2030-01-13", "02:00") },
    ]);

    expect(window.endMs).toBe(at("2030-01-13", "02:00"));
    expect(hourTicks(window, ZONE).at(-1)?.label).toBe("01:00");
  });

  it("rounds a late end up to the next hour", () => {
    const window = axisWindow(DAY, ZONE, [
      { startMs: at(DAY, "18:00"), endMs: at("2030-01-13", "00:15") },
    ]);

    expect(window.endMs).toBe(at("2030-01-13", "01:00"));
  });

  it("draws 23 hours on a spring-forward day, skipping 02:00", () => {
    const date = "2030-03-10";
    const window = axisWindow(date, ZONE, [
      { startMs: at(date, "00:00"), endMs: at("2030-03-11", "00:00") },
    ]);
    const labels = hourTicks(window, ZONE).map((tick) => tick.label);

    expect(labels).toHaveLength(23);
    expect(labels).not.toContain("02:00");
  });

  it("draws 25 hours on a fall-back day, repeating 01:00", () => {
    const date = "2030-11-03";
    const window = axisWindow(date, ZONE, [
      { startMs: at(date, "00:00"), endMs: at("2030-11-04", "00:00") },
    ]);
    const labels = hourTicks(window, ZONE).map((tick) => tick.label);

    expect(labels).toHaveLength(25);
    expect(labels.filter((label) => label === "01:00")).toHaveLength(2);
  });
});

describe("local hour rounding", () => {
  it("rounds to local hours in a zone with a half-hour offset", () => {
    const zone = "Asia/Kolkata";
    const instant = at(DAY, "10:40", zone);

    expect(floorToLocalHour(instant, zone)).toBe(at(DAY, "10:00", zone));
    expect(ceilToLocalHour(instant, zone)).toBe(at(DAY, "11:00", zone));
  });

  it("leaves an instant on the hour unchanged", () => {
    const instant = at(DAY, "10:00");

    expect(ceilToLocalHour(instant, ZONE)).toBe(instant);
  });
});

describe("barPlacement", () => {
  const window = { startMs: 0, endMs: 1000 };

  it("places a bar by its instants", () => {
    expect(barPlacement(window, { startMs: 250, endMs: 500 })).toEqual({
      leftPercent: 25,
      widthPercent: 25,
    });
  });

  it("clips a bar at the window edges", () => {
    expect(barPlacement(window, { startMs: -100, endMs: 1200 })).toEqual({
      leftPercent: 0,
      widthPercent: 100,
    });
  });
});

describe("assignLanes", () => {
  it("keeps non-overlapping bars in one lane", () => {
    const lanes = assignLanes([
      { key: "a", rowKey: "r", startMs: 0, endMs: 10 },
      { key: "b", rowKey: "r", startMs: 20, endMs: 30 },
    ]);

    expect([...lanes.values()]).toEqual([0, 0]);
  });

  it("puts overlapping bars for one row in separate lanes", () => {
    const lanes = assignLanes([
      { key: "published", rowKey: "r", startMs: 0, endMs: 20 },
      { key: "draft", rowKey: "r", startMs: 10, endMs: 30 },
    ]);

    expect(lanes.get("published")).toBe(0);
    expect(lanes.get("draft")).toBe(1);
  });

  it("lets back-to-back shifts share a lane", () => {
    const lanes = assignLanes([
      { key: "a", rowKey: "r", startMs: 0, endMs: 10 },
      { key: "b", rowKey: "r", startMs: 10, endMs: 20 },
    ]);

    expect(lanes.get("b")).toBe(0);
  });

  it("assigns lanes per row", () => {
    const lanes = assignLanes([
      { key: "a", rowKey: "r1", startMs: 0, endMs: 10 },
      { key: "b", rowKey: "r2", startMs: 0, endMs: 10 },
    ]);

    expect(lanes.get("b")).toBe(0);
  });

  it("gives the same lanes whatever the input order", () => {
    const items = [
      { key: "a", rowKey: "r", startMs: 0, endMs: 10 },
      { key: "b", rowKey: "r", startMs: 0, endMs: 10 },
    ];

    expect(assignLanes(items)).toEqual(assignLanes([...items].reverse()));
  });
});

describe("openSlots", () => {
  it("is required minus filled", () => {
    expect(openSlots(3, 1)).toBe(2);
  });

  it("is never negative when a shift is over-filled", () => {
    expect(openSlots(1, 2)).toBe(0);
  });
});

describe("hourlyHeadcount", () => {
  const window = { startMs: 0, endMs: 3 * 3_600_000 };
  const ticks = hourTicks(window, "UTC");

  it("counts a bar in every hour it touches, per position", () => {
    const counts = hourlyHeadcount(ticks, window, [
      { positionId: "cook", startMs: 1_800_000, endMs: 5_400_000 },
      { positionId: "server", startMs: 0, endMs: 3_600_000 },
    ]);

    expect(counts.map((row) => row.byPosition)).toEqual([
      { cook: 1, server: 1 },
      { cook: 1 },
      {},
    ]);
  });

  it("doesn't count a bar that ends exactly when an hour starts", () => {
    const counts = hourlyHeadcount(ticks, window, [
      { positionId: "cook", startMs: 0, endMs: 3_600_000 },
    ]);

    expect(counts[1]?.byPosition).toEqual({});
  });
});

describe("minutes", () => {
  it("measures an overnight shift once, by real time", () => {
    expect(
      minutesBetween(at(DAY, "18:00"), at("2030-01-13", "02:00")),
    ).toBe(480);
  });

  it("formats whole minutes as h:mm", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(485)).toBe("8:05");
    expect(formatDuration(1500)).toBe("25:00");
  });
});

describe("ordering", () => {
  it("sorts employees by name, then employee number, then ID", () => {
    const rows = [
      { id: "b", displayName: "Sam", employeeNumber: "2" },
      { id: "a", displayName: "Sam", employeeNumber: "2" },
      { id: "c", displayName: "Sam", employeeNumber: "1" },
      { id: "d", displayName: "Alex", employeeNumber: "9" },
    ];

    expect(sortEmployees(rows).map((row) => row.id)).toEqual(["d", "c", "a", "b"]);
    expect(sortEmployees([...rows].reverse())).toEqual(sortEmployees(rows));
  });

  it("sorts positions by name, then code, then ID", () => {
    const rows = [
      { id: "2", name: "Server", code: "SERVER" },
      { id: "1", name: "Server", code: "SERVER" },
      { id: "3", name: "Cook", code: "LINE" },
      { id: "4", name: "Cook", code: "GRILL" },
    ];

    expect(sortPositions(rows).map((row) => row.id)).toEqual(["4", "3", "1", "2"]);
  });

  it("keeps a position's color stable and wraps after the palette", () => {
    expect(positionColorIndex(2)).toBe(2);
    expect(positionColorIndex(POSITION_COLOR_COUNT + 1)).toBe(1);
  });
});
