import { isPositiveDecimal, multiplyDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Conversions are explicit rows (`unit_conversions`), never derived. There is no chaining,
// no density and no culinary approximation. A conversion whose exact result needs more
// precision than the target quantity allows is refused rather than rounded.

export const MEASUREMENT_TYPES = ["COUNT", "WEIGHT", "VOLUME"] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

export type UnitDefinition = { code: string; measurementType: MeasurementType };
export type ConversionDefinition = { from: string; to: string; factor: string };

/** Scale of `unit_conversions.factor` (`NUMERIC(14,6)`) and of quantities (`NUMERIC(14,4)`). */
export const FACTOR_SCALE = 6;
export const QUANTITY_SCALE = 4;

export function validateConversion(
  units: readonly UnitDefinition[],
  conversion: ConversionDefinition,
): void {
  const from = units.find((unit) => unit.code === conversion.from);
  const to = units.find((unit) => unit.code === conversion.to);

  if (!from || !to) {
    throw new BusinessRuleError("UNKNOWN_UNIT", "Both units must exist.");
  }

  if (from.code === to.code) {
    throw new BusinessRuleError("SAME_UNIT_CONVERSION", "A unit can't convert to itself.");
  }

  if (from.measurementType !== to.measurementType) {
    throw new BusinessRuleError(
      "INCOMPATIBLE_UNITS",
      "Units of different measurement types can't be converted.",
    );
  }

  if (!isPositiveDecimal(conversion.factor)) {
    throw new BusinessRuleError("INVALID_CONVERSION_FACTOR", "The factor must be positive.");
  }

  toScale(conversion.factor, FACTOR_SCALE);
}

/** Converts a quantity using one explicit conversion row. */
export function convertQuantity(
  quantity: string,
  fromUnit: string,
  toUnit: string,
  units: readonly UnitDefinition[],
  conversions: readonly ConversionDefinition[],
): string {
  const from = units.find((unit) => unit.code === fromUnit);
  const to = units.find((unit) => unit.code === toUnit);

  if (!from || !to) {
    throw new BusinessRuleError("UNKNOWN_UNIT", "Both units must exist.");
  }

  if (from.measurementType !== to.measurementType) {
    throw new BusinessRuleError(
      "INCOMPATIBLE_UNITS",
      "Units of different measurement types can't be converted.",
    );
  }

  if (fromUnit === toUnit) {
    return toScale(quantity, QUANTITY_SCALE);
  }

  const conversion = conversions.find(
    (candidate) => candidate.from === fromUnit && candidate.to === toUnit,
  );

  if (!conversion) {
    throw new BusinessRuleError(
      "NO_APPROVED_CONVERSION",
      `No approved conversion from ${fromUnit} to ${toUnit}.`,
    );
  }

  try {
    return multiplyDecimals(quantity, conversion.factor, QUANTITY_SCALE);
  } catch {
    throw new BusinessRuleError(
      "CONVERSION_PRECISION",
      "The converted quantity needs more precision than is supported.",
    );
  }
}
