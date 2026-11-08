import { describe, expect, it } from "vitest";

import { combinedCapacity, evaluateCapacity } from "./capacity";

const base = { capacity: 4, canOverride: false };

describe("evaluateCapacity", () => {
  it("allows a party equal to capacity", () => {
    expect(evaluateCapacity({ ...base, partySize: 4 }).outcome).toBe("WITHIN_CAPACITY");
  });

  it("allows a party below capacity", () => {
    expect(evaluateCapacity({ ...base, partySize: 1 }).outcome).toBe("WITHIN_CAPACITY");
  });

  it("denies a party above capacity by default", () => {
    expect(evaluateCapacity({ ...base, partySize: 5 }).outcome).toBe("DENIED");
  });

  it("ignores a reason without the permission", () => {
    expect(
      evaluateCapacity({ ...base, partySize: 5, overrideReason: "Tight squeeze" }).outcome,
    ).toBe("DENIED");
  });

  it("allows a permitted override with a reason, trimmed", () => {
    expect(
      evaluateCapacity({
        ...base,
        partySize: 5,
        canOverride: true,
        overrideReason: "  Extra chair  ",
      }),
    ).toEqual({ outcome: "OVERRIDDEN", reason: "Extra chair" });
  });

  it.each([undefined, null, "", "   "])(
    "requires a reason even with the permission: %j",
    (overrideReason) => {
      expect(
        evaluateCapacity({ ...base, partySize: 5, canOverride: true, overrideReason }).outcome,
      ).toBe("REASON_REQUIRED");
    },
  );

  it("records no override when none was needed", () => {
    expect(
      evaluateCapacity({
        ...base,
        partySize: 2,
        canOverride: true,
        overrideReason: "Unneeded",
      }),
    ).toEqual({ outcome: "WITHIN_CAPACITY" });
  });
});

describe("combinedCapacity", () => {
  it("sums the tables", () => {
    expect(combinedCapacity([{ capacity: 4 }, { capacity: 6 }])).toBe(10);
  });

  it("is zero with no tables", () => {
    expect(combinedCapacity([])).toBe(0);
  });
});
