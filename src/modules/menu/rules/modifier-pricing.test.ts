import { describe, expect, it } from "vitest";

import { calculateItemAmount } from "./modifier-pricing";

describe("calculateItemAmount", () => {
  it("adds modifier adjustments exactly", () => {
    expect(calculateItemAmount("14.99", ["2.00"])).toBe("16.99");
    expect(calculateItemAmount("14.99", ["1.50", "2.00"])).toBe("18.49");
  });

  it("leaves the price unchanged for zero-price modifiers", () => {
    expect(calculateItemAmount("14.99", ["0.00", "0.00"])).toBe("14.99");
    expect(calculateItemAmount("14.99", [])).toBe("14.99");
  });

  it("supports negative adjustments that stay above zero", () => {
    expect(calculateItemAmount("14.99", ["-1.00"])).toBe("13.99");
  });

  it("avoids floating-point drift", () => {
    expect(calculateItemAmount("0.10", ["0.20"])).toBe("0.30");
  });

  it("refuses a negative total and values beyond cents", () => {
    expect(() => calculateItemAmount("1.00", ["-2.00"])).toThrow(/negative/);
    expect(() => calculateItemAmount("1.005", [])).toThrow(/two decimal places/);
  });
});
