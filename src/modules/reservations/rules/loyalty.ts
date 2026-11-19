import { multiplyExact, sumDecimals, wholeQuotient } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 30 guest loyalty rules (policies 4, 6, 8, 12). Pure and deterministic: points are whole
// numbers; money stays a decimal string until the single floor.

export const LOYALTY_RATE_MAX = 100;
export const LOYALTY_POINTS_MAX = 1_000_000;

export type EarnedPoints = {
  /** The sum of the CLOSED checks' subtotals (after discounts, before tax). */
  eligibleSubtotal: string;
  points: number;
};

/**
 * Policy 4: floor(sum of CLOSED check subtotals × points per dollar) + points per visit when at
 * least one check is CLOSED. VOIDED and other checks are not passed in.
 */
export function pointsEarned(
  closedSubtotals: readonly string[],
  rates: { pointsPerDollar: number; pointsPerVisit: number },
): EarnedPoints {
  const eligibleSubtotal = sumDecimals(closedSubtotals, 2);

  if (closedSubtotals.length === 0) {
    return { eligibleSubtotal, points: 0 };
  }

  const spend = Number(wholeQuotient(multiplyExact(eligibleSubtotal, String(rates.pointsPerDollar)), "1"));

  return { eligibleSubtotal, points: spend + rates.pointsPerVisit };
}

/** Points the guest may still spend: the balance less rewards on checks not yet closed. */
export function availablePoints(balance: number, pendingCosts: readonly number[]): number {
  return balance - pendingCosts.reduce((sum, cost) => sum + cost, 0);
}

export function assertCanSpend(balance: number, pendingCosts: readonly number[], cost: number): void {
  if (availablePoints(balance, pendingCosts) < cost) {
    throw new BusinessRuleError("INSUFFICIENT_POINTS", "The guest doesn't have enough points for that.");
  }
}

/** Policy 12: an adjustment is whole, not zero, and never leaves available points below zero. */
export function assertValidAdjustment(balance: number, pendingCosts: readonly number[], points: number): void {
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > LOYALTY_POINTS_MAX) {
    throw new BusinessRuleError("INVALID_POINTS", `Enter a whole number of points, not zero, up to ${LOYALTY_POINTS_MAX}.`);
  }

  if (balance + points > LOYALTY_POINTS_MAX * 100) {
    throw new BusinessRuleError("INVALID_POINTS", "That would make the balance too large.");
  }

  if (points < 0) {
    assertCanSpend(balance, pendingCosts, -points);
  }
}

export function assertValidRates(rates: { pointsPerDollar: number; pointsPerVisit: number }): void {
  for (const value of [rates.pointsPerDollar, rates.pointsPerVisit]) {
    if (!Number.isInteger(value) || value < 0 || value > LOYALTY_RATE_MAX) {
      throw new BusinessRuleError("INVALID_LOYALTY_RATE", `Rates are whole numbers from 0 to ${LOYALTY_RATE_MAX}.`);
    }
  }
}

export function assertValidReason(reason: string): string {
  const trimmed = reason.trim();

  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason of 1 to 200 characters.");
  }

  return trimmed;
}
