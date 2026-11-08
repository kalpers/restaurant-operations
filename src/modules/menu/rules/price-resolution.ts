import { BusinessRuleError } from "@/shared/errors/app-error";

// Prices are effective-dated and half-open: a row applies from `effectiveFrom`
// (inclusive) until `effectiveTo` (exclusive; null = open-ended). A location row beats
// the organization default (`locationId` null). There is no third tier: placements
// carry no price override in Phase 7.

export type PriceRow = {
  locationId: string | null;
  price: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export function priceAppliesAt(row: PriceRow, at: Date): boolean {
  return (
    row.effectiveFrom.getTime() <= at.getTime() &&
    (row.effectiveTo === null || at.getTime() < row.effectiveTo.getTime())
  );
}

export type ResolvedPrice = { price: string; scope: "LOCATION" | "ORGANIZATION" };

/**
 * The selling price at an instant, or null when neither scope has an applicable price.
 * More than one applicable row in a scope is a data-integrity error, which the database
 * exclusion constraint prevents; it is refused here rather than guessed at.
 */
export function resolvePrice(
  rows: readonly PriceRow[],
  locationId: string,
  at: Date,
): ResolvedPrice | null {
  const applicable = rows.filter((row) => priceAppliesAt(row, at));

  for (const [scope, scopeLocation] of [
    ["LOCATION", locationId],
    ["ORGANIZATION", null],
  ] as const) {
    const inScope = applicable.filter((row) => row.locationId === scopeLocation);

    if (inScope.length > 1) {
      throw new BusinessRuleError(
        "AMBIGUOUS_PRICE",
        "More than one price is in effect for this item. Contact an administrator.",
      );
    }

    if (inScope[0]) {
      return { price: inScope[0].price, scope };
    }
  }

  return null;
}

/** Whether two half-open intervals share any instant. */
export function intervalsOverlap(
  a: { from: Date; to: Date | null },
  b: { from: Date; to: Date | null },
): boolean {
  const aEndsBeforeBStarts = a.to !== null && a.to.getTime() <= b.from.getTime();
  const bEndsBeforeAStarts = b.to !== null && b.to.getTime() <= a.from.getTime();

  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

export type PriceChangePlan =
  | { close: { index: number; at: Date } | null }
  | { conflict: "NOT_AFTER_CURRENT" | "FUTURE_PRICE_EXISTS" };

/**
 * Plans a new price for one scope starting at `effectiveFrom`: close the open-ended price
 * that started earlier (if any) and insert the new one. A later-dated price already
 * queued must be dealt with first, and the new price must start after the one it replaces.
 * Rows are given for a single scope (one location, or the organization default).
 */
export function planPriceChange(
  scopeRows: readonly PriceRow[],
  effectiveFrom: Date,
): PriceChangePlan {
  const at = effectiveFrom.getTime();

  if (scopeRows.some((row) => row.effectiveFrom.getTime() > at)) {
    return { conflict: "FUTURE_PRICE_EXISTS" };
  }

  if (scopeRows.some((row) => row.effectiveFrom.getTime() === at)) {
    return { conflict: "NOT_AFTER_CURRENT" };
  }

  // Every remaining row started earlier. At most one can still be in force at `at`.
  const index = scopeRows.findIndex((row) => priceAppliesAt(row, effectiveFrom));

  return { close: index >= 0 ? { index, at: effectiveFrom } : null };
}
