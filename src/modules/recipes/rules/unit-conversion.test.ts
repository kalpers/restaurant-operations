import { describe, expect, it } from "vitest";

import {
  convertQuantity,
  validateConversion,
  type ConversionDefinition,
  type UnitDefinition,
} from "./unit-conversion";

const units: UnitDefinition[] = [
  { code: "EACH", measurementType: "COUNT" },
  { code: "OZ_WEIGHT", measurementType: "WEIGHT" },
  { code: "LB", measurementType: "WEIGHT" },
  { code: "G", measurementType: "WEIGHT" },
  { code: "KG", measurementType: "WEIGHT" },
  { code: "FL_OZ", measurementType: "VOLUME" },
  { code: "ML", measurementType: "VOLUME" },
  { code: "L", measurementType: "VOLUME" },
];

const conversions: ConversionDefinition[] = [
  { from: "LB", to: "OZ_WEIGHT", factor: "16.000000" },
  { from: "OZ_WEIGHT", to: "LB", factor: "0.062500" },
  { from: "G", to: "KG", factor: "0.001000" },
  { from: "KG", to: "G", factor: "1000.000000" },
  { from: "ML", to: "L", factor: "0.001000" },
  { from: "L", to: "ML", factor: "1000.000000" },
];

const convert = (quantity: string, from: string, to: string) =>
  convertQuantity(quantity, from, to, units, conversions);

describe("unit conversion", () => {
  it("converts approved pairs exactly", () => {
    expect(convert("1", "LB", "OZ_WEIGHT")).toBe("16.0000");
    expect(convert("1000", "G", "KG")).toBe("1.0000");
    expect(convert("1000", "ML", "L")).toBe("1.0000");
  });

  it("preserves exact decimals", () => {
    expect(convert("0.5", "LB", "OZ_WEIGHT")).toBe("8.0000");
    expect(convert("8", "OZ_WEIGHT", "LB")).toBe("0.5000");
    expect(convert("2.5", "L", "ML")).toBe("2500.0000");
  });

  it("returns the same unit unchanged", () => {
    expect(convert("3", "EACH", "EACH")).toBe("3.0000");
  });

  it("rejects incompatible measurement types", () => {
    expect(() => convert("1", "LB", "FL_OZ")).toThrow(/different measurement types/);
    expect(() => convert("1", "EACH", "G")).toThrow(/different measurement types/);
  });

  it("refuses conversions that aren't approved", () => {
    expect(() => convert("1", "OZ_WEIGHT", "G")).toThrow(/No approved conversion/);
    expect(() => convert("1", "FL_OZ", "ML")).toThrow(/No approved conversion/);
  });

  it("refuses a result that would need rounding", () => {
    expect(() => convert("0.0001", "G", "KG")).toThrow(/more precision/);
  });

  it("validates new conversion rows", () => {
    expect(() => validateConversion(units, { from: "LB", to: "G", factor: "453.592000" })).not.toThrow();
    expect(() => validateConversion(units, { from: "LB", to: "ML", factor: "1" })).toThrow(/different/);
    expect(() => validateConversion(units, { from: "LB", to: "LB", factor: "1" })).toThrow(/itself/);
    expect(() => validateConversion(units, { from: "LB", to: "G", factor: "0" })).toThrow(/positive/);
    expect(() => validateConversion(units, { from: "LB", to: "G", factor: "1.0000001" })).toThrow();
    expect(() => validateConversion(units, { from: "LB", to: "OZ", factor: "1" })).toThrow(/exist/);
  });
});
