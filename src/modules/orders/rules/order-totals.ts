import { calculateItemAmount } from "@/modules/menu/rules/modifier-pricing";
import {
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  subtractDecimals,
  sumDecimals,
  toScale,
} from "@/shared/decimal/decimal";

import type { DiscountType } from "../types";

const MONEY_SCALE = 2;

export type LineAmounts = {
  basePrice: string;
  modifierTotal: string;
  unitPrice: string;
  lineTotal: string;
};

/** Base price plus modifier adjustments, times a positive whole quantity, exactly. */
export function calculateLineAmounts(
  basePrice: string,
  adjustments: readonly string[],
  quantity: number,
): LineAmounts {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError("Quantity must be a positive whole number.");
  }

  const unitPrice = calculateItemAmount(basePrice, adjustments);

  return {
    basePrice: toScale(basePrice, MONEY_SCALE),
    modifierTotal: sumDecimals(adjustments, MONEY_SCALE),
    unitPrice,
    lineTotal: toScale(multiplyExact(unitPrice, String(quantity)), MONEY_SCALE),
  };
}

export type DiscountInput = {
  id: string;
  type: DiscountType;
  value: string;
  /** Application order. */
  sequence: number;
};

export type TotalsInput = {
  /** Only SUBMITTED items count: drafts are previews and voided items are excluded. */
  items: { id: string; status: string; lineTotal: string }[];
  itemDiscounts: (DiscountInput & { orderItemId: string })[];
  orderDiscounts: DiscountInput[];
};

export type Totals = {
  itemSubtotal: string;
  discountTotal: string;
  subtotal: string;
  appliedAmounts: Map<string, string>;
};

/** One discount against what remains eligible: fixed, or a ROUND_HALF_UP percent; capped. */
export function discountAmount(type: DiscountType, value: string, eligible: string): string {
  const raw =
    type === "FIXED_AMOUNT"
      ? toScale(value, MONEY_SCALE)
      : divideRoundHalfUp(multiplyExact(eligible, value), "100", MONEY_SCALE);

  return compareDecimals(raw, eligible) > 0 ? toScale(eligible, MONEY_SCALE) : raw;
}

/** A 100% discount is a comp. */
export function isComp(type: DiscountType, value: string): boolean {
  return type === "PERCENTAGE" && compareDecimals(value, "100") === 0;
}

/**
 * The pre-tax totals of an order. Item discounts apply first, in application order, each
 * against what remains of its line. Order discounts then apply, in application order,
 * against what remains of the whole order. Every discount is capped at what remains, so the
 * subtotal is never negative. No tax, tip or fee.
 */
export function calculateOrderTotals(input: TotalsInput): Totals {
  const appliedAmounts = new Map<string, string>();
  const submitted = input.items.filter((item) => item.status === "SUBMITTED");
  const remainingByItem = new Map(
    submitted.map((item) => [item.id, toScale(item.lineTotal, MONEY_SCALE)]),
  );
  const bySequence = <T extends { sequence: number }>(entries: readonly T[]) =>
    [...entries].sort((a, b) => a.sequence - b.sequence);

  for (const discount of bySequence(input.itemDiscounts)) {
    const remaining = remainingByItem.get(discount.orderItemId);

    if (remaining === undefined) {
      appliedAmounts.set(discount.id, "0.00");
      continue;
    }

    const amount = discountAmount(discount.type, discount.value, remaining);

    appliedAmounts.set(discount.id, amount);
    remainingByItem.set(discount.orderItemId, toScale(subtractDecimals(remaining, amount), MONEY_SCALE));
  }

  let remainingOrder = sumDecimals([...remainingByItem.values()], MONEY_SCALE);

  for (const discount of bySequence(input.orderDiscounts)) {
    const amount = discountAmount(discount.type, discount.value, remainingOrder);

    appliedAmounts.set(discount.id, amount);
    remainingOrder = toScale(subtractDecimals(remainingOrder, amount), MONEY_SCALE);
  }

  const itemSubtotal = sumDecimals(
    submitted.map((item) => item.lineTotal),
    MONEY_SCALE,
  );
  const discountTotal = sumDecimals([...appliedAmounts.values()], MONEY_SCALE);

  return {
    itemSubtotal,
    discountTotal,
    subtotal: toScale(subtractDecimals(itemSubtotal, discountTotal), MONEY_SCALE),
    appliedAmounts,
  };
}
