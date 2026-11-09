import { describe, expect, it } from "vitest";

import { canonicalJson, requestFingerprint } from "@/infrastructure/idempotency/idempotency-service";

import { planLineConsumption } from "./consumption-plan";
import {
  assertItemIsDraft,
  assertItemVoidable,
  assertOrderOpen,
  buildKitchenInstructions,
} from "./order-lifecycle";
import { calculateLineAmounts, calculateOrderTotals, discountAmount, isComp } from "./order-totals";

describe("line amounts", () => {
  it("adds modifier adjustments to the base price and multiplies exactly", () => {
    expect(calculateLineAmounts("15.99", ["0.50", "1.00", "0.00"], 3)).toEqual({
      basePrice: "15.99",
      modifierTotal: "1.50",
      unitPrice: "17.49",
      lineTotal: "52.47",
    });
    // 0.1 + 0.2 in floating point is 0.30000000000000004; here it is exact.
    expect(calculateLineAmounts("0.10", ["0.20"], 1).unitPrice).toBe("0.30");
    expect(calculateLineAmounts("2.00", ["-0.50"], 2)).toMatchObject({ modifierTotal: "-0.50", lineTotal: "3.00" });
  });

  it("refuses a negative price, extra precision and a non-whole quantity", () => {
    expect(() => calculateLineAmounts("1.00", ["-2.00"], 1)).toThrow(/negative/);
    expect(() => calculateLineAmounts("1.001", [], 1)).toThrow();
    expect(() => calculateLineAmounts("1.00", [], 0)).toThrow(RangeError);
    expect(() => calculateLineAmounts("1.00", [], 1.5)).toThrow(RangeError);
  });
});

describe("discounts and order totals", () => {
  const items = [
    { id: "a", status: "SUBMITTED", lineTotal: "17.49" },
    { id: "b", status: "SUBMITTED", lineTotal: "9.99" },
    { id: "draft", status: "DRAFT", lineTotal: "100.00" },
    { id: "void", status: "VOIDED", lineTotal: "50.00" },
  ];

  it("counts only SUBMITTED lines and applies no tax", () => {
    expect(calculateOrderTotals({ items, itemDiscounts: [], orderDiscounts: [] })).toMatchObject({
      itemSubtotal: "27.48",
      discountTotal: "0.00",
      subtotal: "27.48",
    });
  });

  it("rounds percentages half up to cents and caps every discount", () => {
    expect(discountAmount("PERCENTAGE", "10", "22.45")).toBe("2.25");
    expect(discountAmount("PERCENTAGE", "10", "22.44")).toBe("2.24");
    expect(discountAmount("PERCENTAGE", "12.5", "0.04")).toBe("0.01");
    expect(discountAmount("FIXED_AMOUNT", "50", "17.49")).toBe("17.49");
    expect(discountAmount("FIXED_AMOUNT", "5", "17.49")).toBe("5.00");
    expect(discountAmount("PERCENTAGE", "100", "17.49")).toBe("17.49");
    expect(discountAmount("FIXED_AMOUNT", "1", "0.00")).toBe("0.00");
  });

  it("applies item discounts first, then order discounts in application order", () => {
    const totals = calculateOrderTotals({
      items,
      itemDiscounts: [
        { id: "i2", orderItemId: "a", type: "PERCENTAGE", value: "50", sequence: 2 },
        { id: "i1", orderItemId: "a", type: "FIXED_AMOUNT", value: "5.00", sequence: 1 },
        { id: "gone", orderItemId: "void", type: "FIXED_AMOUNT", value: "5.00", sequence: 3 },
      ],
      orderDiscounts: [
        { id: "o2", type: "FIXED_AMOUNT", value: "100.00", sequence: 5 },
        { id: "o1", type: "PERCENTAGE", value: "10", sequence: 4 },
      ],
    });

    // a: 17.49 - 5.00 = 12.49; 50% of 12.49 = 6.245 -> 6.25; remaining 6.24.
    // Order: 6.24 + 9.99 = 16.23; 10% = 1.623 -> 1.62; then 100.00 capped at 14.61.
    expect(Object.fromEntries(totals.appliedAmounts)).toEqual({
      i1: "5.00",
      i2: "6.25",
      gone: "0.00",
      o1: "1.62",
      o2: "14.61",
    });
    expect(totals).toMatchObject({ itemSubtotal: "27.48", discountTotal: "27.48", subtotal: "0.00" });
  });

  it("treats only a 100% discount as a comp", () => {
    expect(isComp("PERCENTAGE", "100.00")).toBe(true);
    expect(isComp("PERCENTAGE", "99.99")).toBe(false);
    expect(isComp("FIXED_AMOUNT", "100.00")).toBe(false);
  });
});

describe("consumption planning", () => {
  const beef = { inventoryItemId: "beef", baseQuantity: "8.0000" };
  const cheese = { inventoryItemId: "cheese", baseQuantity: "1.0000" };
  const onion = { inventoryItemId: "onion", baseQuantity: "1.0000" };
  const quantities = (plan: ReturnType<typeof planLineConsumption>) =>
    Object.fromEntries(plan.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));

  it("uses the recipe's base-unit requirements times the quantity", () => {
    expect(quantities(planLineConsumption({ requirements: [beef, cheese], effects: [], quantity: 3 }))).toEqual({
      beef: "24.0000",
      cheese: "3.0000",
    });
  });

  it("applies ADD, REMOVE and ADJUST, and a substitution as REMOVE plus ADD", () => {
    const plan = planLineConsumption({
      requirements: [beef, cheese, onion],
      effects: [
        { operation: "ADD", inventoryItemId: "bacon", baseQuantity: "2" },
        { operation: "REMOVE", inventoryItemId: "onion" },
        { operation: "ADJUST", inventoryItemId: "cheese", baseQuantity: "1" },
        { operation: "ADJUST", inventoryItemId: "beef", baseQuantity: "-2" },
      ],
      quantity: 1,
    });

    // The plan §79 example, with beef adjusted down.
    expect(quantities(plan)).toEqual({ bacon: "2.0000", beef: "6.0000", cheese: "2.0000" });
    expect(plan.find((entry) => entry.inventoryItemId === "bacon")!.recipeBaseQuantity).toBeNull();

    const swiss = planLineConsumption({
      requirements: [cheese],
      effects: [
        { operation: "REMOVE", inventoryItemId: "cheese" },
        { operation: "ADD", inventoryItemId: "swiss", baseQuantity: "1" },
      ],
      quantity: 2,
    });

    expect(quantities(swiss)).toEqual({ swiss: "2.0000" });
  });

  it("never plans a negative or zero requirement (the shared Phase 8 rule drops it)", () => {
    expect(
      quantities(
        planLineConsumption({
          requirements: [cheese],
          effects: [{ operation: "ADJUST", inventoryItemId: "cheese", baseQuantity: "-3" }],
          quantity: 1,
        }),
      ),
    ).toEqual({});
  });

  it("plans nothing for an item with no recipe and no additions", () => {
    expect(planLineConsumption({ requirements: [], effects: [], quantity: 4 })).toEqual([]);
    expect(
      planLineConsumption({ requirements: [], effects: [{ operation: "REMOVE", inventoryItemId: "x" }], quantity: 1 }),
    ).toEqual([]);
  });

  it("refuses a quantity that would need more than four places", () => {
    expect(() =>
      planLineConsumption({ requirements: [{ inventoryItemId: "x", baseQuantity: "0.00001" }], effects: [], quantity: 1 }),
    ).toThrow();
  });
});

describe("order lifecycle guards", () => {
  it("allows changes only to OPEN orders and DRAFT items", () => {
    expect(() => assertOrderOpen("OPEN")).not.toThrow();
    expect(() => assertOrderOpen("VOIDED")).toThrow(/voided/);
    expect(() => assertOrderOpen("CLOSED")).toThrow(/closed/);
    expect(() => assertItemIsDraft("DRAFT")).not.toThrow();
    expect(() => assertItemIsDraft("SUBMITTED")).toThrow(/Void it/);
  });

  it("voids only SUBMITTED items, once", () => {
    expect(() => assertItemVoidable("SUBMITTED")).not.toThrow();
    expect(() => assertItemVoidable("VOIDED")).toThrow(/already/);
    expect(() => assertItemVoidable("DRAFT")).toThrow(/Remove the draft/);
  });

  it("builds kitchen instructions from modifier instructions then free text", () => {
    expect(buildKitchenInstructions(["Cook medium", null, " ", "No onion"], " Cut in half ")).toBe(
      "Cook medium; No onion; Cut in half",
    );
    expect(buildKitchenInstructions([], null)).toBeNull();
  });
});

describe("idempotency fingerprint", () => {
  it("is independent of key order and sensitive to values", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(requestFingerprint({ orderId: "x", expectedVersion: 2 })).toBe(
      requestFingerprint({ expectedVersion: 2, orderId: "x" }),
    );
    expect(requestFingerprint({ orderId: "x", expectedVersion: 2 })).not.toBe(
      requestFingerprint({ orderId: "x", expectedVersion: 3 }),
    );
  });
});
