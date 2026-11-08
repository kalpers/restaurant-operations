import { sumDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

const MONEY_SCALE = 2;

/**
 * Base price plus each selected modifier's adjustment, in exact decimal arithmetic.
 * No tax, discount, tip or order total: those are not Phase 7.
 */
export function calculateItemAmount(
  basePrice: string,
  adjustments: readonly string[],
): string {
  let amount: string;

  try {
    amount = sumDecimals([basePrice, ...adjustments], MONEY_SCALE);
  } catch {
    throw new BusinessRuleError(
      "INVALID_MONEY_AMOUNT",
      "A price has more than two decimal places or is not a number.",
    );
  }

  if (amount.startsWith("-")) {
    throw new BusinessRuleError(
      "NEGATIVE_ITEM_AMOUNT",
      "The selected modifiers make the item price negative.",
    );
  }

  return amount;
}
