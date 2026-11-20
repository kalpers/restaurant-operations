import { describe, expect, it } from "vitest";

import { pointsDueForRefund, pointsToTake, refundNetOfTax } from "./loyalty-refunds";

// Phase 33 (policies 7, 8): points taken back by refunds.

const snapshot = { eligibleSubtotal: "47.50", pointsPerDollar: 2 };

describe("points due for a refund", () => {
  it("takes back the dollar points of the refunded amount before tax", () => {
    expect(refundNetOfTax({ amount: "10.80", taxAmount: "0.80" })).toBe("10.00");
    // floor(47.50 × 2) − floor(37.50 × 2) = 95 − 75
    expect(pointsDueForRefund(snapshot, [], "10.00")).toBe(20);
  });

  it("works on the running total, so several refunds take what one would", () => {
    const one = pointsDueForRefund(snapshot, [], "10.25");
    const first = pointsDueForRefund(snapshot, [], "5.10");
    const second = pointsDueForRefund(snapshot, ["5.10"], "5.15");

    expect(first + second).toBe(one);
  });

  it("never takes more than the dollar points: the visit points stay", () => {
    expect(pointsDueForRefund(snapshot, [], "47.50")).toBe(95);
    expect(pointsDueForRefund(snapshot, ["47.50"], "5.00")).toBe(0);
    expect(pointsDueForRefund(snapshot, [], "60.00")).toBe(95);
  });

  it("uses the snapshot's rate, whatever the program says now", () => {
    expect(pointsDueForRefund({ eligibleSubtotal: "20.00", pointsPerDollar: 1 }, [], "10.00")).toBe(10);
    expect(pointsDueForRefund({ eligibleSubtotal: "20.00", pointsPerDollar: 0 }, [], "10.00")).toBe(0);
  });

  it("treats a refund whose tax part is larger than its amount as zero", () => {
    expect(refundNetOfTax({ amount: "0.00", taxAmount: "0.50" })).toBe("0.00");
  });
});

describe("points taken", () => {
  it("takes what is due when the guest has it", () => {
    expect(pointsToTake(20, 100, [])).toEqual({ taken: 20, short: 0 });
  });

  it("stops at what the guest can spend, keeping pending rewards whole", () => {
    expect(pointsToTake(20, 30, [15])).toEqual({ taken: 15, short: 5 });
    expect(pointsToTake(20, 10, [15])).toEqual({ taken: 0, short: 20 });
    expect(pointsToTake(20, 0, [])).toEqual({ taken: 0, short: 20 });
  });
});
