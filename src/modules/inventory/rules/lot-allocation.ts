import { addDecimals, compareDecimals, isPositiveDecimal, subtractDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 23 (policy 17, D9, D12): which lots a decrease comes from, as a pure rule. First to
// expire, first out: lots with an expiry date before those without, earliest first, then the
// oldest received, then the lot number. A named lot is used alone. Only CONSUME (and only
// where negative stock is allowed, which the stock policy has already decided) may take more
// than the lots hold; the rest is a shortfall a later increase settles.

export type AllocatableLot = {
  id: string;
  expiresOn: string | null;
  receivedOn: string;
  sequenceNumber: number;
  quantityRemaining: string;
};

export type LotAllocation = { lotId: string; quantity: string };

export function fefoOrder<Lot extends AllocatableLot>(lots: readonly Lot[]): Lot[] {
  return [...lots].sort((a, b) => {
    if (a.expiresOn !== b.expiresOn) {
      if (a.expiresOn === null) {
        return 1;
      }

      if (b.expiresOn === null) {
        return -1;
      }

      return a.expiresOn < b.expiresOn ? -1 : 1;
    }

    if (a.receivedOn !== b.receivedOn) {
      return a.receivedOn < b.receivedOn ? -1 : 1;
    }

    return a.sequenceNumber - b.sequenceNumber;
  });
}

export function allocateFromLots(input: {
  lots: readonly AllocatableLot[];
  /** A positive magnitude in base units. */
  quantity: string;
  namedLotId?: string | null;
  allowShortfall: boolean;
}): { allocations: LotAllocation[]; shortfall: string } {
  if (input.namedLotId) {
    const lot = input.lots.find((candidate) => candidate.id === input.namedLotId);

    if (!lot || compareDecimals(lot.quantityRemaining, input.quantity) < 0) {
      throw new BusinessRuleError("LOT_INSUFFICIENT", "That lot doesn't hold that much.");
    }

    return { allocations: [{ lotId: lot.id, quantity: input.quantity }], shortfall: "0" };
  }

  const allocations: LotAllocation[] = [];
  let left = input.quantity;

  for (const lot of fefoOrder(input.lots)) {
    if (!isPositiveDecimal(left)) {
      break;
    }

    if (!isPositiveDecimal(lot.quantityRemaining)) {
      continue;
    }

    const take = compareDecimals(lot.quantityRemaining, left) < 0 ? lot.quantityRemaining : left;

    allocations.push({ lotId: lot.id, quantity: take });
    left = subtractDecimals(left, take);
  }

  if (isPositiveDecimal(left) && !input.allowShortfall) {
    throw new BusinessRuleError(
      "LOTS_OUT_OF_BALANCE",
      "This item's lots hold less than its stock. Run a count to correct it.",
    );
  }

  return { allocations, shortfall: isPositiveDecimal(left) ? left : "0" };
}

export type OpenShortfall = { movementId: string; transactionId: string; open: string };

/** How much of a new quantity settles earlier shortfalls, oldest first. */
export function settleShortfalls(
  shortfalls: readonly OpenShortfall[],
  available: string,
): { settlements: (OpenShortfall & { quantity: string })[]; rest: string } {
  const settlements: (OpenShortfall & { quantity: string })[] = [];
  let rest = available;

  for (const shortfall of shortfalls) {
    if (!isPositiveDecimal(rest)) {
      break;
    }

    const quantity = compareDecimals(shortfall.open, rest) < 0 ? shortfall.open : rest;

    settlements.push({ ...shortfall, quantity });
    rest = subtractDecimals(rest, quantity);
  }

  return { settlements, rest };
}

/** Expiry status on a business date, for warnings and the lots page (policy 22). */
export function expiryStatus(
  expiresOn: string | null,
  businessDate: string,
  warningDays: number,
): "OK" | "EXPIRING" | "EXPIRED" {
  if (expiresOn === null) {
    return "OK";
  }

  if (expiresOn < businessDate) {
    return "EXPIRED";
  }

  if (warningDays <= 0) {
    return "OK";
  }

  const warnFrom = new Date(`${expiresOn}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() - warningDays);

  return businessDate >= warnFrom.toISOString().slice(0, 10) ? "EXPIRING" : "OK";
}

/** Sums allocations, for checks. */
export function totalAllocated(allocations: readonly LotAllocation[]): string {
  return allocations.reduce((sum, allocation) => addDecimals(sum, allocation.quantity), "0");
}
