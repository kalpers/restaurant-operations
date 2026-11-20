import { compareDecimals, multiplyExact, subtractDecimals, sumDecimals, wholeQuotient } from "@/shared/decimal/decimal";

// Phase 33 loyalty points and refunds (policies 7–9). Pure and deterministic: points are whole
// numbers; money stays a decimal string until the floor.

/** What a visit earned, from its `EARNED` entry's snapshot (never the current program). */
export type EarnedSnapshot = {
  /** CLOSED check subtotals at earning (after discounts and earlier refunds, before tax). */
  eligibleSubtotal: string;
  pointsPerDollar: number;
};

/** The part of a refund that counts for points: what went back, less its tax. Tips are apart. */
export function refundNetOfTax(refund: { amount: string; taxAmount: string }): string {
  const net = subtractDecimals(refund.amount, refund.taxAmount);

  return compareDecimals(net, "0") < 0 ? "0.00" : net;
}

/** floor(max(0, eligible − refunded) × rate): the dollar points the visit still has. */
function dollarPointsLeft(snapshot: EarnedSnapshot, refunded: string): number {
  const left = subtractDecimals(snapshot.eligibleSubtotal, refunded);

  if (compareDecimals(left, "0") <= 0) {
    return 0;
  }

  return Number(wholeQuotient(multiplyExact(left, String(snapshot.pointsPerDollar)), "1"));
}

/**
 * Policy 7: the points one refund takes back, on the visit's running total. `before` is the
 * net of the visit's other RECORDED refunds (after earning), `refund` this one's net. Several
 * small refunds take back exactly what one large refund would. Per-visit points are never
 * taken back: the result never exceeds the dollar points.
 */
export function pointsDueForRefund(snapshot: EarnedSnapshot, before: readonly string[], refund: string): number {
  const earlier = sumDecimals(before, 2);
  const after = sumDecimals([...before, refund], 2);

  return dollarPointsLeft(snapshot, earlier) - dollarPointsLeft(snapshot, after);
}

/**
 * Policy 8: points taken back are what is due, but no more than the guest can spend (the
 * balance less points held by rewards on open checks), and never below zero. The rest is
 * reported as short; it is not carried.
 */
export function pointsToTake(due: number, balance: number, pendingCosts: readonly number[]): { taken: number; short: number } {
  const available = Math.max(0, balance - pendingCosts.reduce((sum, cost) => sum + cost, 0));
  const taken = Math.max(0, Math.min(due, available));

  return { taken, short: Math.max(0, due - taken) };
}
