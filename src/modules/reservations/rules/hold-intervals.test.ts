import { describe, expect, it } from "vitest";

import {
  intervalsOverlap,
  isHoldActive,
  planningWindowIsCurrent,
  reservationBlocksPlanning,
  reservationPlanningInterval,
  walkInHoldInterval,
} from "./hold-intervals";

const settings = { preHoldMinutes: 15, postGraceMinutes: 15 };
const at = (time: string) => new Date(`2026-11-10T${time}:00.000Z`);
const reservationAt = at("19:00");

describe("walk-in hold interval", () => {
  it("is [reservation_at - pre_hold, reservation_at + post_grace)", () => {
    expect(walkInHoldInterval({ reservationAt }, settings)).toEqual({
      start: at("18:45"),
      end: at("19:15"),
    });
  });

  it("reads both durations from the settings", () => {
    expect(
      walkInHoldInterval(
        { reservationAt },
        { preHoldMinutes: 30, postGraceMinutes: 5 },
      ),
    ).toEqual({ start: at("18:30"), end: at("19:05") });
  });

  it.each([
    ["immediately before the start", "18:44", false],
    ["at the start", "18:45", true],
    ["during the interval", "19:00", true],
    ["just before the end", "19:14", true],
    ["at the end", "19:15", false],
  ])("is %s -> active %s", (_label, time, expected) => {
    expect(
      isHoldActive({ status: "CONFIRMED", reservationAt }, at(time), settings),
    ).toBe(expected);
  });

  it.each(["PENDING", "CONFIRMED", "CHECKED_IN"] as const)(
    "%s reservations hold",
    (status) => {
      expect(isHoldActive({ status, reservationAt }, at("19:00"), settings)).toBe(
        true,
      );
    },
  );

  it.each(["CANCELLED", "NO_SHOW", "SEATED", "COMPLETED"] as const)(
    "%s reservations don't hold",
    (status) => {
      expect(isHoldActive({ status, reservationAt }, at("19:00"), settings)).toBe(
        false,
      );
      expect(reservationBlocksPlanning(status)).toBe(false);
    },
  );
});

describe("reservation planning interval", () => {
  const reservation = { reservationAt, expectedDurationMinutes: 90 };

  it("is [reservation_at - pre_hold, reservation_at + duration + post_grace)", () => {
    expect(reservationPlanningInterval(reservation, settings)).toEqual({
      start: at("18:45"),
      end: at("20:45"),
    });
  });

  it("is distinct from the walk-in hold", () => {
    expect(reservationPlanningInterval(reservation, settings).end).not.toEqual(
      walkInHoldInterval(reservation, settings).end,
    );
  });

  it("reads both durations from the settings", () => {
    expect(
      reservationPlanningInterval(reservation, {
        preHoldMinutes: 0,
        postGraceMinutes: 30,
      }),
    ).toEqual({ start: at("19:00"), end: at("21:00") });
  });

  it("crosses midnight", () => {
    const late = {
      reservationAt: at("23:00"),
      expectedDurationMinutes: 120,
    };

    expect(reservationPlanningInterval(late, settings).end).toEqual(
      new Date("2026-11-11T01:15:00.000Z"),
    );
  });

  it("treats adjacent half-open intervals as compatible", () => {
    const first = reservationPlanningInterval(reservation, settings);
    const second = {
      start: first.end,
      end: new Date(first.end.getTime() + 60 * 60 * 1000),
    };

    expect(intervalsOverlap(first, second)).toBe(false);
    expect(intervalsOverlap(second, first)).toBe(false);
  });

  it("detects overlap by a single minute", () => {
    const first = reservationPlanningInterval(reservation, settings);
    const second = {
      start: new Date(first.end.getTime() - 60 * 1000),
      end: new Date(first.end.getTime() + 60 * 60 * 1000),
    };

    expect(intervalsOverlap(first, second)).toBe(true);
  });

  it("treats a window that has ended as no longer current", () => {
    expect(planningWindowIsCurrent(reservation, at("20:44"), settings)).toBe(true);
    expect(planningWindowIsCurrent(reservation, at("20:45"), settings)).toBe(false);
  });
});
