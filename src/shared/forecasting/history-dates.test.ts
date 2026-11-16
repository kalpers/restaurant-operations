import { describe, expect, it } from "vitest";

import { weightedAverage, weightedAverageDecimal } from "./history-dates";

describe("weightedAverageDecimal (Phase 25 policy 1)", () => {
  it("weights newest first, n down to 1, like the integer rule", () => {
    // (3 × 0.5 + 2 × 0.25 + 1 × 0) / 6 = 2 / 6
    expect(weightedAverageDecimal(["0.5", "0.25", "0"], 4)).toBe("0.3333");
    expect(weightedAverageDecimal(["30", "20", "10"], 2)).toBe(weightedAverage([30, 20, 10]));
  });

  it("has no floating error and rounds half up", () => {
    // (2 × 0.1 + 1 × 0.2) / 3 = 0.1333…
    expect(weightedAverageDecimal(["0.1", "0.2"], 4)).toBe("0.1333");
    // (2 × 0.00015 + 1 × 0.00015) / 3 = 0.00015, half up to 0.0002
    expect(weightedAverageDecimal(["0.00015", "0.00015"], 4)).toBe("0.0002");
    expect(weightedAverageDecimal(["1.25"], 2)).toBe("1.25");
  });

  it("refuses no values", () => {
    expect(() => weightedAverageDecimal([], 2)).toThrow();
  });
});
