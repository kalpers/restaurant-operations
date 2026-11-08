import { addDecimals, compareDecimals, isPositiveDecimal } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { TRANSACTION_DIRECTION, type InventoryTransactionType } from "../types";

/**
 * Approved negative-inventory policy. `allowNegative` is
 * `location_settings.allow_negative_inventory` (default false). When false nothing may leave
 * QOH below zero. When true, only CONSUME may. WASTE, ADJUST_DECREASE, COUNT_DECREASE and
 * TRANSFER_OUT never may. Increases are always allowed. Nothing is clamped.
 */
export function assertStockPolicy(input: {
  type: InventoryTransactionType;
  quantityBefore: string;
  baseQuantityDelta: string;
  allowNegative: boolean;
}): string {
  const quantityAfter = addDecimals(input.quantityBefore, input.baseQuantityDelta);
  const decreasing = compareDecimals(input.baseQuantityDelta, "0") < 0;

  if (decreasing && compareDecimals(quantityAfter, "0") < 0) {
    if (!(input.type === "CONSUME" && input.allowNegative)) {
      throw new BusinessRuleError(
        "INSUFFICIENT_STOCK",
        "There isn't enough stock on hand for that.",
      );
    }
  }

  return quantityAfter;
}

/** The sign each type must carry, so a WASTE can never add stock by accident. */
export function assertDirection(type: InventoryTransactionType, baseQuantityDelta: string): void {
  const positive = isPositiveDecimal(baseQuantityDelta);
  const negative = compareDecimals(baseQuantityDelta, "0") < 0;

  if (!positive && !negative) {
    throw new BusinessRuleError("ZERO_QUANTITY", "The quantity must not be zero.");
  }

  if ((TRANSACTION_DIRECTION[type] === 1) !== positive) {
    throw new BusinessRuleError(
      "WRONG_DIRECTION",
      `${type} must ${TRANSACTION_DIRECTION[type] === 1 ? "add" : "remove"} stock.`,
    );
  }
}
