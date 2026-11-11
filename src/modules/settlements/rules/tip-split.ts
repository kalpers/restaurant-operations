import { divideRoundHalfUp, multiplyExact, sumDecimals } from "@/shared/decimal/decimal";

// Phase 18 policy D24: one business date's pool shared by worked hours × position points.
// Exact integer arithmetic: weights are seconds × points in hundredths, shares are whole cents
// by largest remainder, so the lines always add up exactly to the pool.

export type TipParticipant = {
  employeeId: string;
  employeeNumber: string;
  positionId: string;
  positionCode: string;
  workedSeconds: number;
  /** Decimal string, at most 2 places, > 0. */
  points: string;
};

export type TipLine = TipParticipant & {
  workedHours: string;
  weightedHours: string;
  share: string;
};

function toCents(money: string): bigint {
  const negative = money.startsWith("-");
  const [whole, fraction = ""] = money.replace("-", "").split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));

  return negative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");

  return `${whole}.${fraction}`;
}

function pointsHundredths(points: string): bigint {
  return toCents(points);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Lines for every participant who worked (zero-second participants are dropped). A zero pool
 * or nobody participating gives shares of zero or no lines; nothing is ever negative.
 */
export function splitTipPool(pool: string, participants: readonly TipParticipant[]): TipLine[] {
  const working = participants.filter((participant) => participant.workedSeconds > 0);
  const weights = working.map((participant) => BigInt(participant.workedSeconds) * pointsHundredths(participant.points));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const poolCents = toCents(pool);

  if (poolCents < 0n) {
    throw new Error("A tip pool can't be negative.");
  }

  const base = working.map((_, index) => (totalWeight === 0n ? 0n : (poolCents * weights[index]!) / totalWeight));
  const remainders = working.map((_, index) =>
    totalWeight === 0n ? 0n : (poolCents * weights[index]!) % totalWeight,
  );
  let leftover = totalWeight === 0n ? 0n : poolCents - base.reduce((sum, cents) => sum + cents, 0n);
  const order = working
    .map((participant, index) => ({ participant, index }))
    .sort((left, right) => {
      const remainder = remainders[right.index]! - remainders[left.index]!;

      if (remainder !== 0n) {
        return remainder > 0n ? 1 : -1;
      }

      return (
        compareText(left.participant.employeeNumber, right.participant.employeeNumber) ||
        compareText(left.participant.employeeId, right.participant.employeeId) ||
        compareText(left.participant.positionCode, right.participant.positionCode)
      );
    });
  const shares = [...base];

  for (const { index } of order) {
    if (leftover === 0n) {
      break;
    }

    shares[index] = shares[index]! + 1n;
    leftover -= 1n;
  }

  return working.map((participant, index) => ({
    ...participant,
    workedHours: divideRoundHalfUp(String(participant.workedSeconds), "3600", 4),
    weightedHours: divideRoundHalfUp(multiplyExact(String(participant.workedSeconds), participant.points), "3600", 4),
    share: fromCents(shares[index]!),
  }));
}

export function totalWeightedHours(lines: readonly TipLine[]): string {
  return sumDecimals(
    lines.map((line) => line.weightedHours),
    4,
  );
}
