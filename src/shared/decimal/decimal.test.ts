import { describe, expect, it } from "vitest";

import {
  addDecimals,
  compareDecimals,
  DecimalError,
  divideRoundHalfUp,
  isPositiveDecimal,
  multiplyDecimals,
  multiplyExact,
  negateDecimal,
  roundHalfUp,
  subtractDecimals,
  sumDecimals,
  toScale,
  wholeQuotient,
  wholeQuotientCeiling,
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

  it("subtracts and negates exactly", () => {
    expect(subtractDecimals("10.0000", "12.5")).toBe("-2.5000");
    expect(negateDecimal("3.25")).toBe("-3.25");
    expect(negateDecimal("0.00")).toBe("0.00");
    expect(multiplyExact("1.5", "2.25")).toBe("3.375");
  });

  it("divides with ROUND_HALF_UP, halves away from zero", () => {
    expect(divideRoundHalfUp("50", "20", 4)).toBe("2.5000");
    expect(divideRoundHalfUp("1", "3", 4)).toBe("0.3333");
    expect(divideRoundHalfUp("2", "3", 4)).toBe("0.6667");
    expect(divideRoundHalfUp("0.00005", "1", 4)).toBe("0.0001");
    expect(divideRoundHalfUp("0.00004999", "1", 4)).toBe("0.0000");
    expect(divideRoundHalfUp("-0.00005", "1", 4)).toBe("-0.0001");
    expect(divideRoundHalfUp("10", "-4", 2)).toBe("-2.50");
    expect(roundHalfUp("2.34565", 4)).toBe("2.3457");
    expect(() => divideRoundHalfUp("1", "0", 4)).toThrow(DecimalError);
  });

  it("multiplies exactly and refuses a product that needs more places", () => {
    expect(multiplyDecimals("1", "16.000000", 6)).toBe("16.000000");
    expect(multiplyDecimals("2.5", "16", 4)).toBe("40.0000");
    expect(() => multiplyDecimals("0.000001", "0.5", 6)).toThrow(DecimalError);
  });
});

describe("whole quotients (Phase 19)", () => {
  it("floors and ceils exact quotients without rounding", () => {
    expect(wholeQuotient("100.0000", "8.0000")).toBe("12");
    expect(wholeQuotient("7", "8")).toBe("0");
    expect(wholeQuotient("0.9", "0.3")).toBe("3");
    expect(wholeQuotientCeiling("25", "12")).toBe("3");
    expect(wholeQuotientCeiling("24.0000", "12")).toBe("2");
    expect(wholeQuotientCeiling("0", "12")).toBe("0");
  });

  it("refuses a negative dividend or a non-positive divisor", () => {
    expect(() => wholeQuotient("-1", "2")).toThrow();
    expect(() => wholeQuotient("1", "0")).toThrow();
    expect(() => wholeQuotientCeiling("1", "-2")).toThrow();
  });
});
