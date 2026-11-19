import { describe, expect, it } from "vitest";

import {
  assertCanSpend,
  assertValidAdjustment,
  assertValidRates,
  assertValidReason,
  availablePoints,
  pointsEarned,
} from "./loyalty";

describe("loyalty rules (Phase 30)", () => {
  it("earns the floor of subtotal × rate, plus the visit points", () => {
    expect(pointsEarned(["24.99", "10.50"], { pointsPerDollar: 1, pointsPerVisit: 0 })).toEqual({
      eligibleSubtotal: "35.49",
      points: 35,
    });
    expect(pointsEarned(["24.99"], { pointsPerDollar: 3, pointsPerVisit: 5 })).toEqual({
      eligibleSubtotal: "24.99",
      points: 79,
    });
  });

  it("earns nothing without a closed check, even with visit points", () => {
    expect(pointsEarned([], { pointsPerDollar: 2, pointsPerVisit: 10 })).toEqual({ eligibleSubtotal: "0.00", points: 0 });
  });

  it("earns visit points only when the rate per dollar is zero, and only visit points on a $0 check", () => {
    expect(pointsEarned(["80.00"], { pointsPerDollar: 0, pointsPerVisit: 1 }).points).toBe(1);
    expect(pointsEarned(["0.00"], { pointsPerDollar: 1, pointsPerVisit: 1 }).points).toBe(1);
    expect(pointsEarned(["0.99"], { pointsPerDollar: 1, pointsPerVisit: 0 }).points).toBe(0);
  });

  it("works out available points from pending rewards", () => {
    expect(availablePoints(100, [20, 30])).toBe(50);
    expect(() => assertCanSpend(100, [90], 20)).toThrow(expect.objectContaining({ code: "INSUFFICIENT_POINTS" }));
    expect(() => assertCanSpend(100, [80], 20)).not.toThrow();
  });

  it("refuses an adjustment that is zero, fractional or leaves available points below zero", () => {
    expect(() => assertValidAdjustment(10, [], 0)).toThrow(expect.objectContaining({ code: "INVALID_POINTS" }));
    expect(() => assertValidAdjustment(10, [], 1.5)).toThrow(expect.objectContaining({ code: "INVALID_POINTS" }));
    expect(() => assertValidAdjustment(10, [5], -6)).toThrow(expect.objectContaining({ code: "INSUFFICIENT_POINTS" }));
    expect(() => assertValidAdjustment(10, [5], -5)).not.toThrow();
    expect(() => assertValidAdjustment(0, [], 25)).not.toThrow();
  });

  it("checks rates and reasons", () => {
    expect(() => assertValidRates({ pointsPerDollar: 101, pointsPerVisit: 0 })).toThrow(
      expect.objectContaining({ code: "INVALID_LOYALTY_RATE" }),
    );
    expect(() => assertValidRates({ pointsPerDollar: 1, pointsPerVisit: -1 })).toThrow();
    expect(() => assertValidRates({ pointsPerDollar: 0, pointsPerVisit: 100 })).not.toThrow();
    expect(assertValidReason("  Goodwill ")).toBe("Goodwill");
    expect(() => assertValidReason(" ")).toThrow(expect.objectContaining({ code: "INVALID_REASON" }));
  });
});
