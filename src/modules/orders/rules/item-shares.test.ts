import { describe, expect, it } from "vitest";

import { splitIntoShares } from "./item-shares";

const sum = (values: string[]) => values.reduce((total, value) => total + Math.round(Number(value) * 100), 0);

describe("splitIntoShares", () => {
  it("splits evenly when the cents divide", () => {
    expect(splitIntoShares("16.00", 2)).toEqual(["8.00", "8.00"]);
  });

  it("gives leftover cents to the first shares", () => {
    expect(splitIntoShares("10.00", 3)).toEqual(["3.34", "3.33", "3.33"]);
    expect(splitIntoShares("15.99", 4)).toEqual(["4.00", "4.00", "4.00", "3.99"]);
  });

  it("always adds up to the line total", () => {
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(sum(splitIntoShares("123.45", count))).toBe(12345);
    }
  });

  it("allows a zero line and refuses counts outside 2 to 10", () => {
    expect(splitIntoShares("0.00", 2)).toEqual(["0.00", "0.00"]);
    expect(() => splitIntoShares("10.00", 1)).toThrow(RangeError);
    expect(() => splitIntoShares("10.00", 11)).toThrow(RangeError);
  });
});
