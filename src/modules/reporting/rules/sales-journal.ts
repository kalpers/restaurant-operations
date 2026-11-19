import { addDecimals, compareDecimals, negateDecimal, subtractDecimals, toScale } from "@/shared/decimal/decimal";

// Phase 28 sales journal (policy 8, amendment 2). Pure: the day's recorded figures in, one
// balanced set of debit and credit lines per business date out. Fixed line codes the
// bookkeeper maps to their own accounts; no chart of accounts lives here.
//
// For each date, with CLOSED orders:
//   Dr TENDER/<type>         tender amounts plus tips
//   Dr DISCOUNT / COMP       discounts and comps applied
//   Dr SALES/TAX_INCLUDED    tax that was inside menu prices, taken back out of sales
//   Cr SALES/<category>      item line totals by menu category snapshot
//   Cr TAX/<category code>   tax charged (added and included)
//   Cr TIPS_PAYABLE          tips recorded with tenders
// and, on the date they were recorded:
//   Dr REFUND/<type>, Dr TAX/REFUNDED, Dr TIP_REFUND/<type>   Cr TENDER/<type>
//   cash over or short from closed drawers, against TENDER/CASH.
// Phase 31 gift cards (policy 16), on the date each happened:
//   Dr TENDER/<payment type>  Cr GIFT_CARD/ISSUED        a card sold or reloaded (voids reverse it)
//   Dr GIFT_CARD/CASHED_OUT   Cr TENDER/CASH             a balance paid out in cash
//   GIFT_CARD/ADJUSTED against GIFT_CARD_ADJUSTMENT/ADJUSTED for manager adjustments.
// Spending a card stays TENDER/GIFT_CARD; the bookkeeper maps it and GIFT_CARD/* to one
// liability account. A card sale is never SALES.
// Tenders equal total due plus tips, and total due = item subtotal - discounts - included tax
// + tax, so a correct day always balances; one that doesn't is refused, never exported.

export const JOURNAL_LINE_TYPES = [
  "SALES",
  "DISCOUNT",
  "COMP",
  "TAX",
  "TENDER",
  "TIPS_PAYABLE",
  "REFUND",
  "TIP_REFUND",
  "CASH_OVER_SHORT",
  "GIFT_CARD",
  "GIFT_CARD_ADJUSTMENT",
] as const;

export type JournalLineType = (typeof JOURNAL_LINE_TYPES)[number];

export type JournalDayFacts = {
  businessDate: string;
  /** Item line totals of CLOSED orders by menu category name ("Uncategorized" when none). */
  salesByCategory: { category: string; amount: string }[];
  discounts: string;
  comps: string;
  includedTax: string;
  taxByCategory: { code: string; amount: string }[];
  tenders: { tenderType: string; amount: string; tips: string }[];
  refunds: { tenderType: string; amount: string; tax: string; tips: string }[];
  /** Counted minus expected, per closed drawer session. */
  drawerVariances: string[];
  /** Phase 31: card sales recorded on the date, by how the guest paid. */
  giftCardSales?: { tenderType: string; amount: string }[];
  /** Phase 31: card sales voided on the date (by their voided business date). */
  giftCardSaleVoids?: { tenderType: string; amount: string }[];
  /** Phase 31: cash paid out for card balances on the date (positive). */
  giftCardCashOuts?: string;
  /** Phase 31: net manager adjustments to card balances on the date (signed). */
  giftCardAdjustments?: string;
};

export type JournalRow = {
  businessDate: string;
  lineType: JournalLineType;
  code: string;
  debit: string;
  credit: string;
};

export class JournalOutOfBalance extends Error {
  constructor(
    readonly businessDate: string,
    readonly debits: string,
    readonly credits: string,
  ) {
    super(`Journal for ${businessDate} does not balance: debits ${debits}, credits ${credits}.`);
  }
}

const ORDER: Record<JournalLineType, number> = {
  SALES: 0,
  DISCOUNT: 1,
  COMP: 2,
  TAX: 3,
  TIPS_PAYABLE: 4,
  TENDER: 5,
  REFUND: 6,
  TIP_REFUND: 7,
  CASH_OVER_SHORT: 8,
  GIFT_CARD: 9,
  GIFT_CARD_ADJUSTMENT: 10,
};

export function buildJournalDay(facts: JournalDayFacts): JournalRow[] {
  const lines = new Map<string, JournalRow>();

  const post = (lineType: JournalLineType, code: string, side: "debit" | "credit", amount: string) => {
    if (compareDecimals(amount, "0") === 0) {
      return;
    }

    const key = `${lineType}\u0000${code}`;
    const row = lines.get(key) ?? { businessDate: facts.businessDate, lineType, code, debit: "0.00", credit: "0.00" };

    row[side] = toScale(addDecimals(row[side], amount), 2);
    lines.set(key, row);
  };

  for (const sale of facts.salesByCategory) {
    post("SALES", sale.category, "credit", sale.amount);
  }

  post("SALES", "TAX_INCLUDED", "debit", facts.includedTax);
  post("DISCOUNT", "DISCOUNT", "debit", facts.discounts);
  post("COMP", "COMP", "debit", facts.comps);

  for (const tax of facts.taxByCategory) {
    post("TAX", tax.code, "credit", tax.amount);
  }

  for (const tender of facts.tenders) {
    post("TENDER", tender.tenderType, "debit", addDecimals(tender.amount, tender.tips));
    post("TIPS_PAYABLE", "TIPS", "credit", tender.tips);
  }

  for (const refund of facts.refunds) {
    post("REFUND", refund.tenderType, "debit", subtractDecimals(refund.amount, refund.tax));
    post("TAX", "REFUNDED", "debit", refund.tax);
    post("TIP_REFUND", refund.tenderType, "debit", refund.tips);
    post("TENDER", refund.tenderType, "credit", addDecimals(refund.amount, refund.tips));
  }

  for (const variance of facts.drawerVariances) {
    if (compareDecimals(variance, "0") > 0) {
      post("TENDER", "CASH", "debit", variance);
      post("CASH_OVER_SHORT", "CASH", "credit", variance);
    } else if (compareDecimals(variance, "0") < 0) {
      post("CASH_OVER_SHORT", "CASH", "debit", negateDecimal(variance));
      post("TENDER", "CASH", "credit", negateDecimal(variance));
    }
  }

  for (const sale of facts.giftCardSales ?? []) {
    post("TENDER", sale.tenderType, "debit", sale.amount);
    post("GIFT_CARD", "ISSUED", "credit", sale.amount);
  }

  for (const voided of facts.giftCardSaleVoids ?? []) {
    post("GIFT_CARD", "ISSUED", "debit", voided.amount);
    post("TENDER", voided.tenderType, "credit", voided.amount);
  }

  post("GIFT_CARD", "CASHED_OUT", "debit", facts.giftCardCashOuts ?? "0");
  post("TENDER", "CASH", "credit", facts.giftCardCashOuts ?? "0");

  const adjustment = facts.giftCardAdjustments ?? "0";

  if (compareDecimals(adjustment, "0") > 0) {
    post("GIFT_CARD_ADJUSTMENT", "ADJUSTED", "debit", adjustment);
    post("GIFT_CARD", "ADJUSTED", "credit", adjustment);
  } else if (compareDecimals(adjustment, "0") < 0) {
    post("GIFT_CARD", "ADJUSTED", "debit", negateDecimal(adjustment));
    post("GIFT_CARD_ADJUSTMENT", "ADJUSTED", "credit", negateDecimal(adjustment));
  }

  const rows = [...lines.values()].sort(
    (left, right) => ORDER[left.lineType] - ORDER[right.lineType] || left.code.localeCompare(right.code),
  );
  const debits = rows.reduce((sum, row) => addDecimals(sum, row.debit), "0.00");
  const credits = rows.reduce((sum, row) => addDecimals(sum, row.credit), "0.00");

  if (compareDecimals(debits, credits) !== 0) {
    throw new JournalOutOfBalance(facts.businessDate, toScale(debits, 2), toScale(credits, 2));
  }

  return rows;
}
