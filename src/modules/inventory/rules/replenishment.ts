import {
  compareDecimals,
  isPositiveDecimal,
  subtractDecimals,
  toScale,
  wholeQuotientCeiling,
} from "@/shared/decimal/decimal";
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

export type SuggestionCandidate = {
  inventoryItemId: string;
  quantityOnHand: string;
  thresholds: Thresholds;
  /** Base units still to arrive on this location's DRAFT, SUBMITTED and PARTIALLY_RECEIVED orders. */
  outstandingBaseQuantity: string;
  preferred: { supplierItemId: string; supplierId: string; baseUnitsPerPurchase: string } | null;
};

export type SuggestedLine = {
  inventoryItemId: string;
  supplierItemId: string;
  supplierId: string;
  /** Base units still needed after what's already on order. */
  needBaseQuantity: string;
  /** Whole purchase units, rounded up, so the need is always covered. */
  orderedQuantity: string;
};

/**
 * Phase 19 policy 16: what to put on draft orders. Need = the Phase 8 suggested quantity minus
 * what is already on order; a positive need with a preferred supplier item becomes a line of
 * whole purchase units, rounded up. Lines are grouped by supplier in input order.
 */
export function suggestPurchaseLines(candidates: readonly SuggestionCandidate[]): {
  bySupplier: Map<string, SuggestedLine[]>;
  withoutSupplier: { inventoryItemId: string; needBaseQuantity: string }[];
} {
  const bySupplier = new Map<string, SuggestedLine[]>();
  const withoutSupplier: { inventoryItemId: string; needBaseQuantity: string }[] = [];

  for (const candidate of candidates) {
    const { suggestedQuantity } = evaluateStock(candidate.quantityOnHand, candidate.thresholds);

    if (suggestedQuantity === null) {
      continue;
    }

    const need = toScale(subtractDecimals(suggestedQuantity, candidate.outstandingBaseQuantity), 4);

    if (!isPositiveDecimal(need)) {
      continue;
    }

    if (!candidate.preferred) {
      withoutSupplier.push({ inventoryItemId: candidate.inventoryItemId, needBaseQuantity: need });
      continue;
    }

    const lines = bySupplier.get(candidate.preferred.supplierId) ?? [];

    lines.push({
      inventoryItemId: candidate.inventoryItemId,
      supplierItemId: candidate.preferred.supplierItemId,
      supplierId: candidate.preferred.supplierId,
      needBaseQuantity: need,
      orderedQuantity: wholeQuotientCeiling(need, candidate.preferred.baseUnitsPerPurchase),
    });
    bySupplier.set(candidate.preferred.supplierId, lines);
  }

  return { bySupplier, withoutSupplier };
}
