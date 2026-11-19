import { addDecimals, compareDecimals, subtractDecimals, sumDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 31 gift card limits (policies 4, 9, 10, 12; amendment 4). Pure, exact decimal strings.

const MONEY_SCALE = 2;
export const MIN_GIFT_CARD_SALE = "1.00";

/** A sale or reload: at least 1.00, and the card may not go over the maximum balance. */
export function assertSaleWithinLimits(amount: string, balance: string, maxBalance: string): string {
  if (compareDecimals(amount, MIN_GIFT_CARD_SALE) < 0) {
    throw new BusinessRuleError("GIFT_CARD_SALE_TOO_SMALL", `A gift card is sold for at least ${MIN_GIFT_CARD_SALE}.`);
  }

  const after = toScale(addDecimals(balance, amount), MONEY_SCALE);

  if (compareDecimals(after, maxBalance) > 0) {
    const room = toScale(subtractDecimals(maxBalance, balance), MONEY_SCALE);

    throw new BusinessRuleError(
      "GIFT_CARD_MAX_BALANCE",
      `A card holds at most ${toScale(maxBalance, MONEY_SCALE)}. This card can take ${room} more.`,
      { maxBalance: toScale(maxBalance, MONEY_SCALE), room },
    );
  }

  return after;
}

/** Cash for a sale: what the guest handed over must cover it; the rest is change. */
export function saleChange(amount: string, receivedAmount: string): string {
  if (compareDecimals(receivedAmount, amount) < 0) {
    throw new BusinessRuleError("INSUFFICIENT_CASH", "The cash received doesn't cover the card amount.");
  }

  return toScale(subtractDecimals(receivedAmount, amount), MONEY_SCALE);
}

/** Taking value off a card: never more than it holds. */
export function assertCardCovers(amount: string, balance: string): void {
  if (compareDecimals(amount, balance) > 0) {
    throw new BusinessRuleError(
      "INSUFFICIENT_GIFT_CARD_BALANCE",
      `This card holds ${toScale(balance, MONEY_SCALE)}.`,
      { balance: toScale(balance, MONEY_SCALE) },
    );
  }
}

/**
 * A refund onto a card (amendment 4): at most that card's RECORDED tenders on the check minus
 * its RECORDED refunds there. Returns what is left after this one.
 */
export function assertCardRefundWithinLimits(
  tenders: readonly { status: string; amount: string }[],
  refunds: readonly { status: string; amount: string }[],
  amount: string,
): string {
  const paid = sumDecimals(tenders.filter((row) => row.status === "RECORDED").map((row) => row.amount), MONEY_SCALE);
  const refunded = sumDecimals(refunds.filter((row) => row.status === "RECORDED").map((row) => row.amount), MONEY_SCALE);
  const remaining = toScale(subtractDecimals(paid, refunded), MONEY_SCALE);

  if (compareDecimals(amount, remaining) > 0) {
    throw new BusinessRuleError(
      "REFUND_EXCEEDS_GIFT_CARD",
      `At most ${remaining} more can go back onto this card for this check.`,
      { remaining },
    );
  }

  return toScale(subtractDecimals(remaining, amount), MONEY_SCALE);
}

/** An adjustment: not zero, and the card stays between zero and the maximum balance. */
export function assertAdjustmentWithinLimits(amount: string, balance: string, maxBalance: string): string {
  if (compareDecimals(amount, "0") === 0) {
    throw new BusinessRuleError("INVALID_ADJUSTMENT", "Enter an amount to add or remove.");
  }

  const after = toScale(addDecimals(balance, amount), MONEY_SCALE);

  if (compareDecimals(after, "0") < 0) {
    assertCardCovers(toScale(subtractDecimals("0", amount), MONEY_SCALE), balance);
  }

  if (compareDecimals(after, maxBalance) > 0) {
    throw new BusinessRuleError(
      "GIFT_CARD_MAX_BALANCE",
      `A card holds at most ${toScale(maxBalance, MONEY_SCALE)}.`,
      { maxBalance: toScale(maxBalance, MONEY_SCALE) },
    );
  }

  return after;
}

/** A cash-out pays the whole balance, which must be above zero. */
export function assertCanCashOut(balance: string): string {
  if (compareDecimals(balance, "0") <= 0) {
    throw new BusinessRuleError("GIFT_CARD_EMPTY", "This card has no balance to cash out.");
  }

  return toScale(balance, MONEY_SCALE);
}

/** Parses a signed adjustment such as `-5.00` or `12.5`. */
export function parseSignedMoney(value: string): string {
  const trimmed = value.trim();

  if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(trimmed)) {
    throw new BusinessRuleError("INVALID_AMOUNT", "Enter an amount in dollars and cents.");
  }

  return toScale(trimmed, MONEY_SCALE);
}
