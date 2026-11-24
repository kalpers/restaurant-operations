import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  isPositiveDecimal,
  subtractDecimals,
  toScale,
} from "@/shared/decimal/decimal";

import { COST_SCALE } from "../types";
import { extendCost } from "./costing";

// Phase 37 (policies 3–8, D3–D8): lot costing as pure rules. A `LOT` item's lots carry a
// per-unit cost and the exact value of what remains. Taking part of a lot takes quantity ×
// carrying cost (half-up to four places), never more than the lot holds; taking the rest of
// a lot takes all of its remaining value, so a lot's value always ends at zero with its
// quantity. A lot or shortfall with no cost moves no value.

export const COSTING_METHODS = ["WEIGHTED_AVERAGE", "LOT"] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];

/** Phase 37 (policy 2): why a method changed, as a code (no free text on a cost record). */
export const COSTING_CHANGE_REASONS = [
  "SUPPLIER_PRICES_VARY",
  "OWNER_OR_ACCOUNTANT_REQUEST",
  "CORRECTION",
  "OTHER",
] as const;
export type CostingChangeReason = (typeof COSTING_CHANGE_REASONS)[number];

export type CostedLot = {
  quantityRemaining: string;
  carryingUnitCost: string | null;
  valueRemaining: string | null;
};

/** The value leaving a lot (or closing a shortfall) when `quantity` of it is taken. */
export function valueTaken(lot: CostedLot, quantity: string): string | null {
  if (lot.valueRemaining === null) {
    return null;
  }

  if (compareDecimals(quantity, lot.quantityRemaining) >= 0) {
    return toScale(lot.valueRemaining, COST_SCALE);
  }

  if (lot.carryingUnitCost === null) {
    return null;
  }

  const extended = extendCost(quantity, lot.carryingUnitCost);

  return compareDecimals(extended, lot.valueRemaining) > 0 ? toScale(lot.valueRemaining, COST_SCALE) : extended;
}

/** Sums costs that are known; null when none is. */
export function sumKnown(values: readonly (string | null)[]): string | null {
  const known = values.filter((value): value is string => value !== null);

  return known.length === 0 ? null : toScale(known.reduce((sum, value) => addDecimals(sum, value), "0"), COST_SCALE);
}

/** A per-unit cost for display: total ÷ quantity, half-up to four places. */
export function unitCostOf(total: string | null, quantity: string): string | null {
  return total === null || !isPositiveDecimal(quantity) ? null : divideRoundHalfUp(total, quantity, COST_SCALE);
}

/**
 * D6: the cost of a CONSUME's shortfall per unit: the last lot this removal took from,
 * else the location's most recently received costed lot, else none.
 */
export function shortfallUnitCost(lastTakenCarrying: string | null, latestLotCarrying: string | null): string | null {
  return lastTakenCarrying ?? latestLotCarrying;
}

/**
 * D5: the per-unit cost of found stock (adjustment and count increases): what's on hand is
 * worth per unit, else the latest lot's carrying cost, else none.
 */
export function onHandUnitCost(input: {
  quantityOnHand: string;
  stockValue: string | null;
  latestLotCarrying: string | null;
}): string | null {
  if (isPositiveDecimal(input.quantityOnHand) && input.stockValue !== null && compareDecimals(input.stockValue, "0") >= 0) {
    return divideRoundHalfUp(input.stockValue, input.quantityOnHand, COST_SCALE);
  }

  return input.latestLotCarrying;
}

/** D8: the "average on hand" shown for a `LOT` item; unchanged while nothing is on hand. */
export function averageOnHand(stockValue: string, quantityOnHand: string, previous: string | null): string | null {
  if (!isPositiveDecimal(quantityOnHand) || compareDecimals(stockValue, "0") < 0) {
    return previous;
  }

  return divideRoundHalfUp(stockValue, quantityOnHand, COST_SCALE);
}

/**
 * D3: switching to `LOT`, each open lot is carried at the current average. Each lot's value
 * is its quantity × the average (half-up), so the total may differ from quantity × average
 * by rounding; the change record keeps both.
 */
export function carryOverToLots<Lot extends { quantityRemaining: string }>(
  lots: readonly Lot[],
  average: string | null,
): (Lot & { carryingUnitCost: string | null; valueRemaining: string | null })[] {
  return lots.map((lot) => ({
    ...lot,
    carryingUnitCost: average,
    valueRemaining: average === null ? null : extendCost(lot.quantityRemaining, average),
  }));
}

/** D3: switching back to weighted average, the average is the lots' value ÷ quantity. */
export function averageFromLots(stockValue: string | null, quantityOnHand: string, previous: string | null): string | null {
  if (stockValue === null) {
    return previous;
  }

  return averageOnHand(stockValue, quantityOnHand, previous);
}

/**
 * D7: the values of the lots arriving on a transfer. Each piece keeps the value it left the
 * sender with where known (else quantity × the sent unit cost); the last piece, or the
 * found remainder, takes whatever makes the total exactly the value sent.
 */
export function splitArrivingValue(input: {
  pieces: readonly { quantity: string; value: string | null }[];
  restQuantity: string;
  valueSent: string | null;
  unitCostSent: string | null;
}): { pieces: (string | null)[]; rest: string | null } {
  const fallback = (quantity: string) => (input.unitCostSent === null ? null : extendCost(quantity, input.unitCostSent));
  const pieces = input.pieces.map((piece) => piece.value ?? fallback(piece.quantity));

  if (input.valueSent === null) {
    return { pieces, rest: isPositiveDecimal(input.restQuantity) ? fallback(input.restQuantity) : null };
  }

  const covered = pieces.reduce<string>((sum, value) => addDecimals(sum, value ?? "0"), "0");
  const left = subtractDecimals(input.valueSent, covered);

  if (isPositiveDecimal(input.restQuantity)) {
    return { pieces, rest: compareDecimals(left, "0") < 0 ? "0.0000" : toScale(left, COST_SCALE) };
  }

  if (pieces.length > 0) {
    const last = pieces.length - 1;
    const adjusted = addDecimals(pieces[last] ?? "0", left);

    pieces[last] = compareDecimals(adjusted, "0") < 0 ? "0.0000" : toScale(adjusted, COST_SCALE);
  }

  return { pieces, rest: null };
}
