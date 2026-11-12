import { describe, expect, it } from "vitest";

import { allocateOrderDiscount, calculateOrderTax, type TaxableItem } from "./order-tax";
import { calculateOrderTotals } from "./order-totals";

const FOOD = { taxCategoryId: "cat-food", taxCategoryCode: "FOOD" };
const ALCOHOL = { taxCategoryId: "cat-alc", taxCategoryCode: "ALCOHOL" };

function item(id: string, category: typeof FOOD | null, rate: string | null): TaxableItem {
  return {
    id,
    taxCategoryId: category?.taxCategoryId ?? null,
    taxCategoryCode: category?.taxCategoryCode ?? null,
    taxRate: rate,
  };
}

describe("order discount allocation", () => {
  it("splits in proportion to each item's net, adding up exactly", () => {
    const shares = allocateOrderDiscount(
      new Map([
        ["a", "10.00"],
        ["b", "20.00"],
        ["c", "30.00"],
      ]),
      "6.00",
    );

    expect(Object.fromEntries(shares)).toEqual({ a: "1.00", b: "2.00", c: "3.00" });
  });

  it("gives leftover cents by largest remainder, then item ID", () => {
    // 1.00 three ways: 0.333.. each; one cent left over goes to the lowest ID.
    const even = allocateOrderDiscount(
      new Map([
        ["b", "5.00"],
        ["a", "5.00"],
        ["c", "5.00"],
      ]),
      "1.00",
    );

    expect(Object.fromEntries(even)).toEqual({ a: "0.34", b: "0.33", c: "0.33" });

    // 0.10 over 1.00 and 2.00: 0.0333 and 0.0666; the larger remainder gets the cent.
    const uneven = allocateOrderDiscount(
      new Map([
        ["a", "1.00"],
        ["b", "2.00"],
      ]),
      "0.10",
    );

    expect(Object.fromEntries(uneven)).toEqual({ a: "0.03", b: "0.07" });
  });

  it("allocates nothing when there is no discount or nothing to discount", () => {
    expect(Object.fromEntries(allocateOrderDiscount(new Map([["a", "5.00"]]), "0.00"))).toEqual({ a: "0.00" });
    expect(Object.fromEntries(allocateOrderDiscount(new Map([["a", "0.00"]]), "0.00"))).toEqual({ a: "0.00" });
  });
});

describe("order tax", () => {
  it("taxes each (category, rate) group once and rounds half up", () => {
    const tax = calculateOrderTax({
      items: [item("a", FOOD, "8.2500"), item("b", FOOD, "8.2500"), item("c", ALCOHOL, "10.0000")],
      itemNetAmounts: new Map([
        ["a", "10.10"],
        ["b", "0.10"],
        ["c", "7.25"],
      ]),
      orderDiscountAmount: "0.00",
    });

    // FOOD: 10.20 x 8.25% = 0.8415 -> 0.84. ALCOHOL: 7.25 x 10% = 0.725 -> 0.73 (half up).
    expect(tax.lines).toEqual([
      { taxCategoryId: "cat-alc", taxCategoryCode: "ALCOHOL", taxRate: "10.0000", taxableAmount: "7.25",
        taxIncluded: false, taxAmount: "0.73" },
      { taxCategoryId: "cat-food", taxCategoryCode: "FOOD", taxRate: "8.2500", taxableAmount: "10.20",
        taxIncluded: false, taxAmount: "0.84" },
    ]);
    expect(tax.taxTotal).toBe("1.57");
  });

  it("rounds per group, not per item", () => {
    // Ten items of 0.05 at 10%: per item 0.005 would round to 0.01 each (0.10);
    // the group is 0.50 x 10% = 0.05.
    const ids = Array.from({ length: 10 }, (_, index) => `i${index}`);
    const tax = calculateOrderTax({
      items: ids.map((id) => item(id, FOOD, "10.0000")),
      itemNetAmounts: new Map(ids.map((id) => [id, "0.05"])),
      orderDiscountAmount: "0.00",
    });

    expect(tax.taxTotal).toBe("0.05");
  });

  it("leaves items with no rate untaxed but still gives them an order-discount share", () => {
    const tax = calculateOrderTax({
      items: [item("a", FOOD, "10.0000"), item("b", null, null)],
      itemNetAmounts: new Map([
        ["a", "10.00"],
        ["b", "10.00"],
      ]),
      orderDiscountAmount: "4.00",
    });

    expect(tax.taxableByItem.get("a")).toBe("8.00");
    expect(tax.taxableByItem.get("b")).toBe("8.00");
    expect(tax.taxTotal).toBe("0.80");
  });

  it("taxes a 0% category at zero and a fully comped order at zero", () => {
    const zero = calculateOrderTax({
      items: [item("a", FOOD, "0.0000")],
      itemNetAmounts: new Map([["a", "12.00"]]),
      orderDiscountAmount: "0.00",
    });

    expect(zero.taxTotal).toBe("0.00");
    expect(zero.lines).toHaveLength(1);

    const comped = calculateOrderTax({
      items: [item("a", FOOD, "8.0000")],
      itemNetAmounts: new Map([["a", "12.00"]]),
      orderDiscountAmount: "12.00",
    });

    expect(comped.taxTotal).toBe("0.00");
  });

  it("returns no tax for an order with no taxable items", () => {
    expect(calculateOrderTax({ items: [], itemNetAmounts: new Map(), orderDiscountAmount: "0.00" })).toMatchObject({
      taxTotal: "0.00",
      lines: [],
    });
  });

  it("works with the totals rule: item discounts first, then order discounts", () => {
    const totals = calculateOrderTotals({
      items: [
        { id: "a", status: "SUBMITTED", lineTotal: "20.00" },
        { id: "b", status: "SUBMITTED", lineTotal: "10.00" },
        { id: "v", status: "VOIDED", lineTotal: "50.00" },
        { id: "d", status: "DRAFT", lineTotal: "9.00" },
      ],
      itemDiscounts: [{ id: "d1", orderItemId: "a", type: "FIXED_AMOUNT", value: "5.00", sequence: 1 }],
      orderDiscounts: [{ id: "d2", type: "PERCENTAGE", value: "10", sequence: 2 }],
    });

    expect(totals.subtotal).toBe("22.50");
    expect(totals.orderDiscountAmount).toBe("2.50");
    expect(Object.fromEntries(totals.itemNetAmounts)).toEqual({ a: "15.00", b: "10.00" });

    const tax = calculateOrderTax({
      items: [item("a", FOOD, "6.0000"), item("b", FOOD, "6.0000")],
      itemNetAmounts: totals.itemNetAmounts,
      orderDiscountAmount: totals.orderDiscountAmount,
    });

    // Shares: a 1.50, b 1.00. Taxable 13.50 + 9.00 = 22.50 = subtotal; 6% = 1.35.
    expect(tax.taxTotal).toBe("1.35");
    expect(tax.lines[0]!.taxableAmount).toBe(totals.subtotal);
  });
});

// Phase 20 policies 15 and 16 (D13-D15).
describe("tax included in prices and exempt checks", () => {
  const included = (id: string, rate: string): TaxableItem => ({ ...item(id, ALCOHOL, rate), taxIncluded: true });

  it("extracts tax from a price that includes it: price × rate ÷ (100 + rate), half up", () => {
    // 10.00 at 8.25% included: 10 × 8.25 / 108.25 = 0.7621.. → 0.76; pre-tax 9.24.
    const tax = calculateOrderTax({
      items: [included("a", "8.25")],
      itemNetAmounts: new Map([["a", "10.00"]]),
      orderDiscountAmount: "0.00",
    });

    expect(tax).toMatchObject({ taxTotal: "0.76", includedTaxTotal: "0.76" });
    expect(tax.lines).toEqual([
      expect.objectContaining({ taxIncluded: true, taxAmount: "0.76", taxableAmount: "9.24" }),
    ]);
  });

  it("keeps included and added tax in separate lines and totals", () => {
    const tax = calculateOrderTax({
      items: [included("a", "10"), item("b", FOOD, "10")],
      itemNetAmounts: new Map([
        ["a", "11.00"],
        ["b", "10.00"],
      ]),
      orderDiscountAmount: "0.00",
    });

    // a: 11 × 10 / 110 = 1.00 included; b: 10 × 10% = 1.00 added.
    expect(tax).toMatchObject({ taxTotal: "2.00", includedTaxTotal: "1.00" });
    expect(tax.lines.map((line) => [line.taxCategoryCode, line.taxIncluded])).toEqual([
      ["ALCOHOL", true],
      ["FOOD", false],
    ]);
  });

  it("takes the discount before extracting included tax", () => {
    const tax = calculateOrderTax({
      items: [included("a", "10")],
      itemNetAmounts: new Map([["a", "22.00"]]),
      orderDiscountAmount: "11.00",
    });

    expect(tax.includedTaxTotal).toBe("1.00");
  });

  it("charges an exempt check no tax, still taking included tax out of the price", () => {
    const tax = calculateOrderTax({
      items: [included("a", "10"), item("b", FOOD, "10")],
      itemNetAmounts: new Map([
        ["a", "11.00"],
        ["b", "10.00"],
      ]),
      orderDiscountAmount: "0.00",
      exempt: true,
    });

    // Guest pays: (21.00 − 1.00 included) + 0 tax = 20.00.
    expect(tax).toMatchObject({ taxTotal: "0.00", includedTaxTotal: "1.00", lines: [] });
  });

  it("keeps subtotal + tax = what the guest pays, with tax inside the price", () => {
    const tax = calculateOrderTax({
      items: [included("a", "8.25"), included("b", "8.25")],
      itemNetAmounts: new Map([
        ["a", "5.00"],
        ["b", "7.50"],
      ]),
      orderDiscountAmount: "0.00",
    });
    const subtotal = (12.5 * 100 - Number(tax.includedTaxTotal) * 100) / 100;

    expect((subtotal * 100 + Number(tax.taxTotal) * 100) / 100).toBe(12.5);
  });
});
