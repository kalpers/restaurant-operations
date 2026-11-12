import {
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  sumDecimals,
  toScale,
} from "@/shared/decimal/decimal";

const MONEY_SCALE = 2;

/** A SUBMITTED item's tax snapshot. A null rate means the item isn't taxed. */
export type TaxableItem = {
  id: string;
  taxCategoryId: string | null;
  taxCategoryCode: string | null;
  taxRate: string | null;
  /** Phase 20 (policy 15): the price already includes this tax. */
  taxIncluded?: boolean;
};

export type TaxLine = {
  taxCategoryId: string;
  taxCategoryCode: string;
  taxRate: string;
  /** Pre-tax amount: for tax included in prices, the price less the tax in it. */
  taxableAmount: string;
  taxAmount: string;
  taxIncluded: boolean;
};

export type OrderTax = {
  /** All tax the guest pays: added and included. Zero on an exempt check. */
  taxTotal: string;
  /**
   * Phase 20 (D14): tax contained in the item prices. It comes off the subtotal, so the
   * subtotal stays pre-tax. Worked out on an exempt check too, where none is added back.
   */
  includedTaxTotal: string;
  lines: TaxLine[];
  /** Each item's taxable base: its net after item discounts, less its order-discount share. */
  taxableByItem: Map<string, string>;
};

function toCents(value: string): bigint {
  const [whole, fraction = ""] = toScale(value, MONEY_SCALE).split(".");
  const negative = whole!.startsWith("-");
  const cents = BigInt(whole!.replace("-", "")) * 100n + BigInt(fraction.padEnd(2, "0"));

  return negative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;

  return negative ? `-${text}` : text;
}

/**
 * Splits the order-level discount across items in proportion to each item's net amount
 * (after item discounts). Whole cents by largest remainder, ties by item ID, so the shares
 * add up exactly to the discount (approved Phase 17 policy A5).
 */
export function allocateOrderDiscount(
  itemNetAmounts: ReadonlyMap<string, string>,
  orderDiscountAmount: string,
): Map<string, string> {
  const entries = [...itemNetAmounts.entries()]
    .map(([id, net]) => ({ id, net: toCents(net) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = entries.reduce((sum, entry) => sum + entry.net, 0n);
  const discount = toCents(orderDiscountAmount);
  const shares = new Map<string, string>();

  if (total <= 0n || discount <= 0n) {
    for (const entry of entries) shares.set(entry.id, "0.00");
    return shares;
  }

  const planned = entries.map((entry) => {
    const exact = discount * entry.net;

    return { id: entry.id, cents: exact / total, remainder: exact % total };
  });
  let leftover = discount - planned.reduce((sum, entry) => sum + entry.cents, 0n);
  const byRemainder = [...planned].sort((a, b) =>
    a.remainder === b.remainder ? (a.id < b.id ? -1 : 1) : a.remainder > b.remainder ? -1 : 1,
  );

  for (const entry of byRemainder) {
    if (leftover <= 0n) break;
    entry.cents += 1n;
    leftover -= 1n;
  }

  for (const entry of planned) shares.set(entry.id, fromCents(entry.cents));

  return shares;
}

/**
 * Exclusive tax on the post-discount amount of SUBMITTED items, from their tax snapshots
 * (policy A5). Items are grouped by (Tax Category, rate); each group's tax is
 * ROUND_HALF_UP of its taxable base times the rate, to cents. Items with a null rate are
 * untaxed. Tips are never part of it.
 */
export function calculateOrderTax(input: {
  items: readonly TaxableItem[];
  itemNetAmounts: ReadonlyMap<string, string>;
  orderDiscountAmount: string;
  /** Phase 20 (policy 16, D15): a tax-exempt check. */
  exempt?: boolean;
}): OrderTax {
  const shares = allocateOrderDiscount(input.itemNetAmounts, input.orderDiscountAmount);
  const taxableByItem = new Map<string, string>();
  const groups = new Map<string, { line: Omit<TaxLine, "taxableAmount" | "taxAmount">; cents: bigint }>();

  for (const item of input.items) {
    const net = input.itemNetAmounts.get(item.id);

    if (net === undefined) continue;

    const taxable = toCents(net) - toCents(shares.get(item.id) ?? "0.00");

    taxableByItem.set(item.id, fromCents(taxable));

    if (item.taxRate === null || item.taxCategoryId === null || item.taxCategoryCode === null) {
      continue;
    }

    const rate = toScale(item.taxRate, 4);
    const included = item.taxIncluded === true;
    const key = `${item.taxCategoryId}|${rate}|${included}`;
    const group = groups.get(key) ?? {
      line: { taxCategoryId: item.taxCategoryId, taxCategoryCode: item.taxCategoryCode, taxRate: rate, taxIncluded: included },
      cents: 0n,
    };

    group.cents += taxable;
    groups.set(key, group);
  }

  const lines = [...groups.values()]
    .map(({ line, cents }) => {
      const amount = fromCents(cents);

      if (!line.taxIncluded) {
        return {
          ...line,
          taxableAmount: amount,
          taxAmount: divideRoundHalfUp(multiplyExact(amount, line.taxRate), "100", MONEY_SCALE),
        };
      }

      // Phase 20 (D14): the tax inside a price is amount × rate ÷ (100 + rate), half up.
      const taxAmount = divideRoundHalfUp(
        multiplyExact(amount, line.taxRate),
        sumDecimals(["100", line.taxRate], 4),
        MONEY_SCALE,
      );

      return { ...line, taxableAmount: fromCents(cents - toCents(taxAmount)), taxAmount };
    })
    .sort((a, b) =>
      a.taxCategoryCode === b.taxCategoryCode
        ? compareDecimals(a.taxRate, b.taxRate) || Number(a.taxIncluded) - Number(b.taxIncluded)
        : a.taxCategoryCode < b.taxCategoryCode
          ? -1
          : 1,
    );
  const includedTaxTotal = sumDecimals(
    lines.filter((line) => line.taxIncluded).map((line) => line.taxAmount),
    MONEY_SCALE,
  );

  if (input.exempt) {
    // An exempt check pays no tax: tax inside prices still comes off, and none is added.
    return { taxTotal: "0.00", includedTaxTotal, lines: [], taxableByItem };
  }

  return {
    taxTotal: sumDecimals(
      lines.map((line) => line.taxAmount),
      MONEY_SCALE,
    ),
    includedTaxTotal,
    lines,
    taxableByItem,
  };
}
