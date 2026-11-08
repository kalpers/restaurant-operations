import { describe, expect, it } from "vitest";

import {
  addDecimals,
  compareDecimals,
  DecimalError,
  isPositiveDecimal,
  multiplyDecimals,
  sumDecimals,
  toScale,
} from "./decimal";

describe("decimal arithmetic", () => {
  it("adds money exactly where floating point would not", () => {
    expect(addDecimals("0.10", "0.20")).toBe("0.30");
    expect(sumDecimals(["14.99", "2.00"], 2)).toBe("16.99");
    expect(sumDecimals(["14.99", "1.50", "2.00"], 2)).toBe("18.49");
    expect(sumDecimals(["14.99", "0.00"], 2)).toBe("14.99");
  });

  it("handles negatives and zero", () => {
    expect(addDecimals("1.00", "-1.50")).toBe("-0.50");
    expect(addDecimals("-0.25", "0.25")).toBe("0.00");
  });

  it("normalizes to a scale and refuses lost precision", () => {
    expect(toScale("5", 2)).toBe("5.00");
    expect(toScale("1.500", 2)).toBe("1.50");
    expect(() => toScale("1.005", 2)).toThrow(DecimalError);
  });

  it("rejects non-decimal text", () => {
    expect(() => addDecimals("abc", "1")).toThrow(DecimalError);
    expect(() => addDecimals("1e3", "1")).toThrow(DecimalError);
    expect(() => addDecimals("", "1")).toThrow(DecimalError);
  });

  it("compares by value, not by text", () => {
    expect(compareDecimals("1.0", "1.00")).toBe(0);
    expect(compareDecimals("2", "10")).toBe(-1);
    expect(isPositiveDecimal("0.0001")).toBe(true);
    expect(isPositiveDecimal("0")).toBe(false);
    expect(isPositiveDecimal("-1")).toBe(false);
  });

  it("multiplies exactly and refuses a product that needs more places", () => {
    expect(multiplyDecimals("1", "16.000000", 6)).toBe("16.000000");
    expect(multiplyDecimals("2.5", "16", 4)).toBe("40.0000");
    expect(() => multiplyDecimals("0.000001", "0.5", 6)).toThrow(DecimalError);
  });
});
