import { addDecimals, compareDecimals, subtractDecimals, sumDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { parseMoney } from "./settlement-math";

const MONEY_SCALE = 2;

// Phase 17 cash drawer and refund arithmetic (approved policies B10 and E31). Pure, exact
// decimal strings; no floating point and no rounding.

export type DrawerFacts = {
  openingFloat: string;
  /** Cash tenders recorded into the session, any status; only RECORDED count. */
  tenders: readonly { status: string; amount: string; tipAmount: string }[];
  movements: readonly { movementType: string; amount: string }[];
  refunds: readonly { status: string; amount: string }[];
};

export type DrawerTotals = {
  openingFloat: string;
  cashSales: string;
  cashTips: string;
  paidIn: string;
  paidOut: string;
  cashRefunds: string;
  expected: string;
};

/**
 * Expected cash = float + RECORDED cash tenders (amount + tip, which is received minus change)
 * + paid-ins - paid-outs - RECORDED cash refunds. Voided rows don't count.
 */
export function expectedCash(facts: DrawerFacts): DrawerTotals {
  const recorded = facts.tenders.filter((tender) => tender.status === "RECORDED");
  const cashSales = sumDecimals(recorded.map((tender) => tender.amount), MONEY_SCALE);
  const cashTips = sumDecimals(recorded.map((tender) => tender.tipAmount), MONEY_SCALE);
  const paidIn = sumDecimals(
    facts.movements.filter((movement) => movement.movementType === "PAID_IN").map((movement) => movement.amount),
    MONEY_SCALE,
  );
  const paidOut = sumDecimals(
    facts.movements.filter((movement) => movement.movementType === "PAID_OUT").map((movement) => movement.amount),
    MONEY_SCALE,
  );
  const cashRefunds = sumDecimals(
    facts.refunds.filter((refund) => refund.status === "RECORDED").map((refund) => refund.amount),
    MONEY_SCALE,
  );
  const expected = toScale(
    subtractDecimals(
      addDecimals(addDecimals(addDecimals(facts.openingFloat, cashSales), cashTips), paidIn),
      addDecimals(paidOut, cashRefunds),
    ),
    MONEY_SCALE,
  );

  return { openingFloat: toScale(facts.openingFloat, MONEY_SCALE), cashSales, cashTips, paidIn, paidOut, cashRefunds, expected };
}

/** Counted minus expected: negative means the drawer is short. */
export function drawerVariance(counted: string, expected: string): string {
  return toScale(subtractDecimals(counted, expected), MONEY_SCALE);
}

/** A non-negative amount with at most two places, such as a float or a count. */
export function parseNonNegativeMoney(value: string, field: string): string {
  return parseMoney(value, field);
}

export type RefundLimits = {
  /** The order's total due (subtotal + tax) and its tax. */
  totalDue: string;
  taxTotal: string;
  /** Refunds already recorded against the order, any status; only RECORDED count. */
  existing: readonly { status: string; amount: string; taxAmount: string }[];
};

/**
 * Refunds can't return more than the guest owed, nor more tax than was charged (policy B10).
 * Tips aren't refundable through this record. Returns what is left after this refund.
 */
export function assertRefundWithinLimits(limits: RefundLimits, amount: string, taxAmount: string) {
  const recorded = limits.existing.filter((refund) => refund.status === "RECORDED");
  const refunded = sumDecimals(recorded.map((refund) => refund.amount), MONEY_SCALE);
  const refundedTax = sumDecimals(recorded.map((refund) => refund.taxAmount), MONEY_SCALE);
  const remaining = toScale(subtractDecimals(limits.totalDue, refunded), MONEY_SCALE);
  const remainingTax = toScale(subtractDecimals(limits.taxTotal, refundedTax), MONEY_SCALE);

  if (compareDecimals(taxAmount, amount) > 0) {
    throw new BusinessRuleError("INVALID_REFUND_TAX", "The tax part can't be more than the refund.");
  }

  if (compareDecimals(amount, remaining) > 0 || compareDecimals(taxAmount, remainingTax) > 0) {
    throw new BusinessRuleError(
      "REFUND_EXCEEDS_ORDER",
      `This order can be refunded at most ${remaining} more, of which at most ${remainingTax} tax.`,
      { remaining, remainingTax },
    );
  }

  return {
    remaining: toScale(subtractDecimals(remaining, amount), MONEY_SCALE),
    remainingTax: toScale(subtractDecimals(remainingTax, taxAmount), MONEY_SCALE),
  };
}
