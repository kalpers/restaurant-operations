import { compareDecimals, isPositiveDecimal, wholeQuotient } from "@/shared/decimal/decimal";

// Phase 19 pure rules for the 86 board (approved policies A3-A6). All quantities are base-unit
// decimal strings; nothing here reads the database.

/** Items with this many portions or fewer (but at least one) are "running low" (policy A7). */
export const RUNNING_LOW_PORTIONS = 5;

export type Requirement = { inventoryItemId: string; baseQuantity: string };
export type OnHand = { stocked: boolean; quantityOnHand: string };

export type PortionsResult = {
  /** Null when the item has no recipe or no ingredients: no figure, never auto-86'd. */
  portions: number | null;
  /** The ingredient that limits the count (the first in input order on a tie). */
  limitingInventoryItemId: string | null;
};

/**
 * Policy A3: the lowest `floor(on hand / requirement)` over the ingredients, never below zero.
 * An ingredient that isn't actively stocked at the location counts as zero on hand. A
 * requirement of zero or less (a revision can't hold one, but be safe) is ignored.
 */
export function portionsRemaining(
  requirements: readonly Requirement[] | null,
  onHand: ReadonlyMap<string, OnHand>,
): PortionsResult {
  if (!requirements) {
    return { portions: null, limitingInventoryItemId: null };
  }

  let best: { portions: bigint; inventoryItemId: string } | null = null;

  for (const requirement of requirements) {
    if (!isPositiveDecimal(requirement.baseQuantity)) {
      continue;
    }

    const stock = onHand.get(requirement.inventoryItemId);
    const quantity =
      stock && stock.stocked && compareDecimals(stock.quantityOnHand, "0") > 0 ? stock.quantityOnHand : "0";
    const portions = BigInt(wholeQuotient(quantity, requirement.baseQuantity));

    if (best === null || portions < best.portions) {
      best = { portions, inventoryItemId: requirement.inventoryItemId };
    }
  }

  if (best === null) {
    return { portions: null, limitingInventoryItemId: null };
  }

  return {
    portions: best.portions > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(best.portions),
    limitingInventoryItemId: best.inventoryItemId,
  };
}

export type SellabilityInput = {
  /** `menu_items.available`: false means not sold anywhere. */
  available: boolean;
  /** An ACTIVE manual 86 at this location. */
  manuallyOut: boolean;
  /** `location_settings.auto_86_from_stock`. */
  autoEnabled: boolean;
  portions: number | null;
  /** An uncleared sell-anyway override for the current business date. */
  sellAnyway: boolean;
};

export type SellabilityState = "UNAVAILABLE" | "MANUAL_86" | "AUTO_86" | "SELL_ANYWAY" | "SELLABLE";

/**
 * Policies A4-A6. `available = false` beats everything, then a manual 86. Auto-86 applies only
 * when the location turned it on and the item has a figure of zero; sell anyway lifts only
 * auto-86, never a manual 86 or `available = false`.
 */
export function sellabilityState(input: SellabilityInput): SellabilityState {
  if (!input.available) {
    return "UNAVAILABLE";
  }

  if (input.manuallyOut) {
    return "MANUAL_86";
  }

  if (input.autoEnabled && input.portions === 0) {
    return input.sellAnyway ? "SELL_ANYWAY" : "AUTO_86";
  }

  return "SELLABLE";
}

export function isSellable(state: SellabilityState): boolean {
  return state === "SELLABLE" || state === "SELL_ANYWAY";
}

export function isRunningLow(portions: number | null): boolean {
  return portions !== null && portions >= 1 && portions <= RUNNING_LOW_PORTIONS;
}
