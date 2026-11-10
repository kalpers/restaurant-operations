import { describe, expect, it } from "vitest";

import { tileDelta } from "./dashboard-delta";

describe("tileDelta", () => {
  it("subtracts money as exact decimals", () => {
    expect(tileDelta("money", "120.10", "100.00")).toEqual({ text: "+$20.10", direction: "up" });
    expect(tileDelta("money", "0.10", "0.30")).toEqual({ text: "-$0.20", direction: "down" });
    expect(tileDelta("money", "5.00", "5.00")).toEqual({ text: "$0.00", direction: "same" });
  });

  it("keeps precision a JavaScript number would lose", () => {
    expect(tileDelta("money", "90071992547409931.01", "0.00")?.text).toBe("+$90,071,992,547,409,931.01");
  });

  it("compares counts and durations", () => {
    expect(tileDelta("count", 12, 9)).toEqual({ text: "+3", direction: "up" });
    expect(tileDelta("minutes", 8, 10)).toEqual({ text: "-2 min", direction: "down" });
    expect(tileDelta("percent", "31.5", "30.0")).toEqual({ text: "+1.5 pts", direction: "up" });
  });

  it("gives no delta when either day has no value", () => {
    expect(tileDelta("money", null, "1.00")).toBeNull();
    expect(tileDelta("money", "1.00", null)).toBeNull();
    expect(tileDelta("money", "1.00", undefined)).toBeNull();
    expect(tileDelta("count", "n/a", 3)).toBeNull();
  });
});
