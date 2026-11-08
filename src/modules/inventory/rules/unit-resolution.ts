import { isPositiveDecimal, multiplyExact, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { FACTOR_SCALE, QUANTITY_SCALE } from "../types";

// Two explicit mechanisms, never guessed: generic conversions (Phase 7 `unit_conversions`,
// same measurement type, e.g. LB -> OZ_WEIGHT) and an item's own product conversions
// (`inventory_item_unit_conversions`, e.g. CASE -> BOTTLE -> ML for one vodka). An item has
// at most one outgoing product conversion per unit, and no cycles, so the path from any
// unit to the base unit is unique. A path may end with one generic step.

export type UnitFacts = { id: string; code: string; measurementType: string };
export type ConversionEdge = { fromUnitId: string; toUnitId: string; factor: string };

export type ConversionContext = {
  units: readonly UnitFacts[];
  generic: readonly ConversionEdge[];
  product: readonly ConversionEdge[];
};

const noPath = () =>
  new BusinessRuleError(
    "NO_CONVERSION",
    "That unit can't be converted to this item's stock unit. Add a conversion first.",
  );

/** The exact factor that turns one `fromUnitId` into base units. */
export function factorToBase(
  context: ConversionContext,
  fromUnitId: string,
  baseUnitId: string,
): string {
  const genericStep = (unitId: string) =>
    context.generic.find((edge) => edge.fromUnitId === unitId && edge.toUnitId === baseUnitId);
  let factor = "1";
  let current = fromUnitId;
  const visited = new Set<string>();

  for (;;) {
    if (current === baseUnitId) {
      return factor;
    }

    const generic = genericStep(current);

    if (generic) {
      return multiplyExact(factor, generic.factor);
    }

    if (visited.has(current)) {
      throw new BusinessRuleError(
        "CONVERSION_CYCLE",
        "This item's unit conversions loop back on themselves. Fix the configuration.",
      );
    }

    visited.add(current);

    const next = context.product.filter((edge) => edge.fromUnitId === current);

    if (next.length === 0) {
      throw noPath();
    }

    if (next.length > 1) {
      throw new BusinessRuleError(
        "AMBIGUOUS_CONVERSION",
        "This item has more than one conversion from the same unit. Fix the configuration.",
      );
    }

    factor = multiplyExact(factor, next[0]!.factor);
    current = next[0]!.toUnitId;
  }
}

/** Converts an entered quantity to base units exactly, refusing more than four places. */
export function toBaseQuantity(
  context: ConversionContext,
  quantity: string,
  fromUnitId: string,
  baseUnitId: string,
): string {
  const product = multiplyExact(quantity, factorToBase(context, fromUnitId, baseUnitId));

  try {
    return toScale(product, QUANTITY_SCALE);
  } catch {
    throw new BusinessRuleError(
      "CONVERSION_PRECISION",
      "The converted quantity needs more than four decimal places.",
    );
  }
}

/**
 * Validates a new or changed product conversion against the item's other active ones:
 * positive exact factor, distinct units, one outgoing conversion per unit, no cycle.
 */
export function validateProductConversion(
  existing: readonly (ConversionEdge & { id?: string })[],
  candidate: ConversionEdge & { id?: string },
): void {
  if (candidate.fromUnitId === candidate.toUnitId) {
    throw new BusinessRuleError("SAME_UNIT_CONVERSION", "A unit can't convert to itself.");
  }

  if (!isPositiveDecimal(candidate.factor)) {
    throw new BusinessRuleError("INVALID_CONVERSION_FACTOR", "The factor must be positive.");
  }

  try {
    toScale(candidate.factor, FACTOR_SCALE);
  } catch {
    throw new BusinessRuleError(
      "INVALID_CONVERSION_FACTOR",
      "The factor allows at most six decimal places.",
    );
  }

  const others = existing.filter((edge) => edge.id === undefined || edge.id !== candidate.id);

  if (others.some((edge) => edge.fromUnitId === candidate.fromUnitId)) {
    throw new BusinessRuleError(
      "AMBIGUOUS_CONVERSION",
      "This item already converts from that unit. Change that conversion instead.",
    );
  }

  // Following the chain from the candidate's target must never come back to its source.
  const graph = [...others, candidate];
  let current: string | undefined = candidate.toUnitId;
  const seen = new Set<string>();

  while (current !== undefined) {
    if (current === candidate.fromUnitId || seen.has(current)) {
      throw new BusinessRuleError(
        "CONVERSION_CYCLE",
        "That conversion would create a loop between this item's units.",
      );
    }

    seen.add(current);
    current = graph.find((edge) => edge.fromUnitId === current)?.toUnitId;
  }
}
