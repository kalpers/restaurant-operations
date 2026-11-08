import { describe, expect, it } from "vitest";

import {
  assertNoShowAllowed,
  assertReservationTransition,
  assertWaitlistTransition,
  canTransitionReservation,
  partyStatusForReservation,
} from "./lifecycle";

const settings = { preHoldMinutes: 15, postGraceMinutes: 15 };
const reservationAt = new Date("2026-11-10T19:00:00.000Z");
const at = (time: string) => new Date(`2026-11-10T${time}:00.000Z`);

describe("reservation transitions", () => {
  it.each([
    ["PENDING", "CONFIRMED"],
    ["CONFIRMED", "CHECKED_IN"],
    ["CONFIRMED", "CANCELLED"],
    ["CONFIRMED", "NO_SHOW"],
    ["CHECKED_IN", "SEATED"],
    ["SEATED", "COMPLETED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionReservation(from, to)).toBe(true);
  });

  it.each([
    ["PENDING", "CHECKED_IN"],
    ["PENDING", "NO_SHOW"],
    ["CHECKED_IN", "NO_SHOW"],
    ["SEATED", "CANCELLED"],
    ["SEATED", "NO_SHOW"],
    ["COMPLETED", "CANCELLED"],
    ["CANCELLED", "CONFIRMED"],
    ["NO_SHOW", "CHECKED_IN"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(() => assertReservationTransition(from, to)).toThrow(
      expect.objectContaining({ code: "INVALID_RESERVATION_TRANSITION" }),
    );
  });

  it("maps a reservation status to a party status", () => {
    expect(partyStatusForReservation("PENDING")).toBe("EXPECTED");
    expect(partyStatusForReservation("CONFIRMED")).toBe("EXPECTED");
    expect(partyStatusForReservation("CHECKED_IN")).toBe("CHECKED_IN");
    expect(partyStatusForReservation("NO_SHOW")).toBe("NO_SHOW");
  });
});

describe("waitlist transitions", () => {
  it("allows the normal path", () => {
    expect(() => assertWaitlistTransition("WAITING", "NOTIFIED")).not.toThrow();
    expect(() => assertWaitlistTransition("NOTIFIED", "SEATED")).not.toThrow();
    expect(() => assertWaitlistTransition("WAITING", "LEFT")).not.toThrow();
  });

  it.each([
    ["SEATED", "CANCELLED"],
    ["CANCELLED", "WAITING"],
    ["LEFT", "NOTIFIED"],
    ["NOTIFIED", "WAITING"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(() => assertWaitlistTransition(from, to)).toThrow(
      expect.objectContaining({ code: "INVALID_WAITLIST_TRANSITION" }),
    );
  });
});

describe("no-show eligibility", () => {
  it("is refused before the post-grace boundary", () => {
    expect(() =>
      assertNoShowAllowed(
        { status: "CONFIRMED", reservationAt },
        at("19:14"),
        settings,
      ),
    ).toThrow(expect.objectContaining({ code: "NO_SHOW_TOO_EARLY" }));
  });

  it("is allowed exactly at the boundary", () => {
    expect(() =>
      assertNoShowAllowed(
        { status: "CONFIRMED", reservationAt },
        at("19:15"),
        settings,
      ),
    ).not.toThrow();
  });

  it.each(["PENDING", "CHECKED_IN", "SEATED", "CANCELLED"] as const)(
    "is refused for a %s reservation",
    (status) => {
      expect(() =>
        assertNoShowAllowed({ status, reservationAt }, at("21:00"), settings),
      ).toThrow(expect.objectContaining({ code: "NO_SHOW_REQUIRES_CONFIRMED" }));
    },
  );

  it("follows the configured post-grace minutes", () => {
    expect(() =>
      assertNoShowAllowed(
        { status: "CONFIRMED", reservationAt },
        at("19:20"),
        { preHoldMinutes: 15, postGraceMinutes: 30 },
      ),
    ).toThrow(expect.objectContaining({ code: "NO_SHOW_TOO_EARLY" }));
  });
});
