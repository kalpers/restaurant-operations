import { compareDecimals, subtractDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Recommendations only: nothing here creates or submits a purchase order. All amounts are in
// the item's base stock unit. Negative QOH is used as it is, so a shortfall is never hidden.

export type Thresholds = {
  parLevel: string | null;
  reorderLevel: string | null;
  reorderTarget: string | null;
};

const atLeastZero = (value: string) =>
  compareDecimals(value, "0") > 0 ? toScale(value, 4) : "0.0000";

export function evaluateStock(quantityOnHand: string, thresholds: Thresholds) {
  const low =
    thresholds.reorderLevel !== null &&
    compareDecimals(quantityOnHand, thresholds.reorderLevel) <= 0;
  const target = thresholds.reorderTarget ?? thresholds.parLevel;

  return {
    low,
    shortageToPar:
      thresholds.parLevel === null
        ? null
        : atLeastZero(subtractDecimals(thresholds.parLevel, quantityOnHand)),
    suggestedQuantity:
      low && target !== null ? atLeastZero(subtractDecimals(target, quantityOnHand)) : null,
  };
}

/** Thresholds are non-negative, and the reorder point sits at or below par and target. */
export function assertThresholds(thresholds: Thresholds): void {
  for (const value of Object.values(thresholds)) {
    if (value !== null && compareDecimals(value, "0") < 0) {
      throw new BusinessRuleError("INVALID_THRESHOLD", "Levels can't be negative.");
    }
  }

  const { parLevel, reorderLevel, reorderTarget } = thresholds;

  if (reorderLevel !== null && parLevel !== null && compareDecimals(reorderLevel, parLevel) > 0) {
    throw new BusinessRuleError(
      "INVALID_THRESHOLD",
      "The reorder level can't be above the par level.",
    );
  }

  if (
    reorderLevel !== null &&
    reorderTarget !== null &&
    compareDecimals(reorderTarget, reorderLevel) < 0
  ) {
    throw new BusinessRuleError(
      "INVALID_THRESHOLD",
      "The reorder target can't be below the reorder level.",
    );
  }
}
