import { describe, expect, it } from "vitest";

import { buildJournalDay, JournalOutOfBalance, type JournalDayFacts } from "./sales-journal";

const DAY = "2026-11-16";

function facts(overrides: Partial<JournalDayFacts> = {}): JournalDayFacts {
  return {
    businessDate: DAY,
    salesByCategory: [],
    discounts: "0.00",
    comps: "0.00",
    includedTax: "0.00",
    taxByCategory: [],
    tenders: [],
    refunds: [],
    drawerVariances: [],
    ...overrides,
  };
}

const line = (rows: ReturnType<typeof buildJournalDay>, lineType: string, code: string) =>
  rows.find((row) => row.lineType === lineType && row.code === code);

describe("buildJournalDay", () => {
  it("balances sales, discounts, comps, added tax, tenders and tips", () => {
    // Items 50.00 (food 35, drinks 15), discount 5, comp 10; tax 8% on 35 = 2.80;
    // total due 50 - 15 + 2.80 = 37.80, paid by card 37.80 with a 6.00 tip.
    const rows = buildJournalDay(
      facts({
        salesByCategory: [
          { category: "Food", amount: "35.00" },
          { category: "Drinks", amount: "15.00" },
        ],
        discounts: "5.00",
        comps: "10.00",
        taxByCategory: [{ code: "FOOD", amount: "2.80" }],
        tenders: [{ tenderType: "EXTERNAL_CARD", amount: "37.80", tips: "6.00" }],
      }),
    );

    expect(line(rows, "SALES", "Food")).toMatchObject({ debit: "0.00", credit: "35.00" });
    expect(line(rows, "DISCOUNT", "DISCOUNT")).toMatchObject({ debit: "5.00" });
    expect(line(rows, "COMP", "COMP")).toMatchObject({ debit: "10.00" });
    expect(line(rows, "TAX", "FOOD")).toMatchObject({ credit: "2.80" });
    expect(line(rows, "TENDER", "EXTERNAL_CARD")).toMatchObject({ debit: "43.80" });
    expect(line(rows, "TIPS_PAYABLE", "TIPS")).toMatchObject({ credit: "6.00" });
    expect(rows.map((row) => row.lineType)).toEqual(["SALES", "SALES", "DISCOUNT", "COMP", "TAX", "TIPS_PAYABLE", "TENDER"]);
  });

  it("takes tax included in prices back out of sales so the day still balances", () => {
    // A 10.80 item whose price includes 0.80 tax: subtotal 10.00, tax 0.80, total due 10.80.
    const rows = buildJournalDay(
      facts({
        salesByCategory: [{ category: "Drinks", amount: "10.80" }],
        includedTax: "0.80",
        taxByCategory: [{ code: "LIQUOR", amount: "0.80" }],
        tenders: [{ tenderType: "CASH", amount: "10.80", tips: "0.00" }],
      }),
    );

    expect(line(rows, "SALES", "TAX_INCLUDED")).toMatchObject({ debit: "0.80", credit: "0.00" });
    expect(line(rows, "TIPS_PAYABLE", "TIPS")).toBeUndefined();
  });

  it("records refunds, refunded tax and refunded tips against the tender they went back on", () => {
    const rows = buildJournalDay(
      facts({ refunds: [{ tenderType: "CASH", amount: "10.80", tax: "0.80", tips: "2.00" }] }),
    );

    expect(line(rows, "REFUND", "CASH")).toMatchObject({ debit: "10.00" });
    expect(line(rows, "TAX", "REFUNDED")).toMatchObject({ debit: "0.80" });
    expect(line(rows, "TIP_REFUND", "CASH")).toMatchObject({ debit: "2.00" });
    expect(line(rows, "TENDER", "CASH")).toMatchObject({ debit: "0.00", credit: "12.80" });
  });

  it("posts drawer over and short as a balanced pair", () => {
    const rows = buildJournalDay(facts({ drawerVariances: ["-0.20", "1.00"] }));

    expect(line(rows, "CASH_OVER_SHORT", "CASH")).toMatchObject({ debit: "0.20", credit: "1.00" });
    expect(line(rows, "TENDER", "CASH")).toMatchObject({ debit: "1.00", credit: "0.20" });
  });

  it("posts gift card sales, voids, cash-outs and adjustments as balanced pairs, never as sales (Phase 31)", () => {
    const rows = buildJournalDay(
      facts({
        giftCardSales: [
          { tenderType: "CASH", amount: "50.00" },
          { tenderType: "EXTERNAL_CARD", amount: "25.00" },
        ],
        giftCardSaleVoids: [{ tenderType: "CASH", amount: "10.00" }],
        giftCardCashOuts: "4.75",
        giftCardAdjustments: "-2.00",
      }),
    );

    expect(rows.some((row) => row.lineType === "SALES")).toBe(false);
    expect(line(rows, "GIFT_CARD", "ISSUED")).toMatchObject({ debit: "10.00", credit: "75.00" });
    expect(line(rows, "TENDER", "CASH")).toMatchObject({ debit: "50.00", credit: "14.75" });
    expect(line(rows, "TENDER", "EXTERNAL_CARD")).toMatchObject({ debit: "25.00", credit: "0.00" });
    expect(line(rows, "GIFT_CARD", "CASHED_OUT")).toMatchObject({ debit: "4.75", credit: "0.00" });
    expect(line(rows, "GIFT_CARD", "ADJUSTED")).toMatchObject({ debit: "2.00", credit: "0.00" });
    expect(line(rows, "GIFT_CARD_ADJUSTMENT", "ADJUSTED")).toMatchObject({ debit: "0.00", credit: "2.00" });

    const positive = buildJournalDay(facts({ giftCardAdjustments: "3.00" }));

    expect(line(positive, "GIFT_CARD_ADJUSTMENT", "ADJUSTED")).toMatchObject({ debit: "3.00", credit: "0.00" });
    expect(line(positive, "GIFT_CARD", "ADJUSTED")).toMatchObject({ debit: "0.00", credit: "3.00" });
  });

  it("refuses a day that doesn't balance", () => {
    expect(() =>
      buildJournalDay(
        facts({
          salesByCategory: [{ category: "Food", amount: "10.00" }],
          tenders: [{ tenderType: "CASH", amount: "9.99", tips: "0.00" }],
        }),
      ),
    ).toThrow(JournalOutOfBalance);
  });

  it("writes nothing for an empty day", () => {
    expect(buildJournalDay(facts())).toEqual([]);
  });
});
