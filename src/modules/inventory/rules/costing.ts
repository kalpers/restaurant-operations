import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  roundHalfUp,
} from "@/shared/decimal/decimal";

import { COST_SCALE } from "../types";

// Weighted-average cost in the item's base unit (approved Phase 8 policy):
// - ROUND_HALF_UP to four places after each receipt, persisted as NUMERIC(14,4); the next
//   receipt uses that persisted value. No hidden higher-precision state.
// - QOH before at or below zero: never divide by a zero or negative quantity. A receipt that
//   leaves QOH at or below zero keeps the existing average; one that lifts QOH above zero
//   sets the average to that receipt's actual base-unit cost.
// The receipt enters as its total cost, so a base-unit cost that needs more than four
// places (a $27.99 case of 12,000 mL) isn't rounded twice.

/** A receipt's exact base-unit cost, rounded half-up to four places for storage. */
export function baseUnitCost(totalCost: string, baseQuantity: string): string {
  return divideRoundHalfUp(totalCost, baseQuantity, COST_SCALE);
}

/** Total cost of `quantity` at `unitCost`, rounded half-up to four places. */
export function extendCost(quantity: string, unitCost: string): string {
  return roundHalfUp(multiplyExact(quantity, unitCost), COST_SCALE);
}

export function nextAverageCost(input: {
  quantityBefore: string;
  averageBefore: string | null;
  quantityIn: string;
  totalCostIn: string;
}): string | null {
  const quantityAfter = addDecimals(input.quantityBefore, input.quantityIn);
  const receiptUnitCost = baseUnitCost(input.totalCostIn, input.quantityIn);

  if (compareDecimals(input.quantityBefore, "0") <= 0) {
    return compareDecimals(quantityAfter, "0") <= 0 ? input.averageBefore : receiptUnitCost;
  }

  // Stock that arrived with no cost (e.g. an adjustment before any receipt) has no basis
  // to average with, so the receipt's own cost is the first average.
  if (input.averageBefore === null) {
    return receiptUnitCost;
  }

  const valueBefore = multiplyExact(input.quantityBefore, input.averageBefore);

  return divideRoundHalfUp(
    addDecimals(valueBefore, input.totalCostIn),
    quantityAfter,
    COST_SCALE,
  );
}
