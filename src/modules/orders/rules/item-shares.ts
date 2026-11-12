import { toScale } from "@/shared/decimal/decimal";

// Phase 20 (policy 17, D16): one item's line total in equal shares, whole cents by largest
// remainder. Every share has the same remainder, so the leftover cents go to the first
// shares in number order, and the shares always add up exactly to the line total.

export const MIN_SHARES = 2;
export const MAX_SHARES = 10;

export function splitIntoShares(lineTotal: string, count: number): string[] {
  if (!Number.isInteger(count) || count < MIN_SHARES || count > MAX_SHARES) {
    throw new RangeError(`An item is shared between ${MIN_SHARES} and ${MAX_SHARES} ways.`);
  }

  const [whole, fraction = ""] = toScale(lineTotal, 2).split(".");

  if (whole!.startsWith("-")) {
    throw new RangeError("A line total can't be negative.");
  }

  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  const base = cents / BigInt(count);
  const leftover = Number(cents % BigInt(count));

  return Array.from({ length: count }, (_, index) => {
    const share = base + (index < leftover ? 1n : 0n);

    return `${share / 100n}.${(share % 100n).toString().padStart(2, "0")}`;
  });
}
