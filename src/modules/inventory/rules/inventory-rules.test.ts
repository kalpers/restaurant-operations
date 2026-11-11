import { describe, expect, it } from "vitest";

import { baseUnitCost, extendCost, nextAverageCost } from "./costing";
import { assertApprovable, assertCountTransition, variance, variancePosting } from "./counts";
import {
  assertReceivable,
  assertTransition,
  canReceive,
  formatPoNumber,
  lineTotal,
  orderTotal,
  remainingQuantity,
  statusAfterReceipt,
} from "./purchasing";
import { assertThresholds, evaluateStock, suggestPurchaseLines } from "./replenishment";
import { alertCrossing } from "./stock-alerts";
import { assertDirection, assertStockPolicy } from "./stock-policy";
import {
  factorToBase,
  toBaseQuantity,
  validateProductConversion,
  type ConversionContext,
} from "./unit-resolution";

const context: ConversionContext = {
  units: [],
  generic: [
    { fromUnitId: "L", toUnitId: "ML", factor: "1000.000000" },
    { fromUnitId: "LB", toUnitId: "OZ", factor: "16.000000" },
    { fromUnitId: "G", toUnitId: "KG", factor: "0.001000" },
  ],
  product: [
    { fromUnitId: "CASE", toUnitId: "BOTTLE", factor: "12.000000" },
    { fromUnitId: "BOTTLE", toUnitId: "L", factor: "1.000000" },
  ],
};

describe("unit resolution", () => {
  it("returns a same-unit quantity unchanged", () => {
    expect(toBaseQuantity(context, "3", "ML", "ML")).toBe("3.0000");
  });

  it("applies a generic conversion", () => {
    expect(toBaseQuantity(context, "2.5", "LB", "OZ")).toBe("40.0000");
    expect(toBaseQuantity(context, "1.5", "L", "ML")).toBe("1500.0000");
  });

  it("follows a product chain, ending with a generic step", () => {
    // 1 CASE = 12 BOTTLE, 1 BOTTLE = 1 L, 1 L = 1000 ML
    expect(factorToBase(context, "CASE", "ML")).toBe("12000.000000000000000000");
    expect(toBaseQuantity(context, "2", "CASE", "ML")).toBe("24000.0000");
    expect(toBaseQuantity(context, "1", "CASE", "BOTTLE")).toBe("12.0000");
  });

  it("rejects a missing conversion and a result needing more than four places", () => {
    expect(() => toBaseQuantity(context, "1", "KG", "ML")).toThrow(/can't be converted/);
    expect(() => toBaseQuantity(context, "0.0001", "G", "KG")).toThrow(/four decimal places/);
  });

  it("rejects a cyclic configuration if one ever reaches resolution", () => {
    const cyclic: ConversionContext = {
      units: [],
      generic: [],
      product: [
        { fromUnitId: "A", toUnitId: "B", factor: "2" },
        { fromUnitId: "B", toUnitId: "A", factor: "0.5" },
      ],
    };

    expect(() => toBaseQuantity(cyclic, "1", "A", "BASE")).toThrow(/loop/);
  });

  it("validates new product conversions: no self, no duplicate source, no cycle", () => {
    const existing = [
      { id: "1", fromUnitId: "CASE", toUnitId: "BOTTLE", factor: "12" },
      { id: "2", fromUnitId: "BOTTLE", toUnitId: "L", factor: "1" },
    ];

    expect(() =>
      validateProductConversion(existing, { fromUnitId: "PACK", toUnitId: "BOTTLE", factor: "6" }),
    ).not.toThrow();
    expect(() =>
      validateProductConversion(existing, { fromUnitId: "BOTTLE", toUnitId: "BOTTLE", factor: "1" }),
    ).toThrow(/itself/);
    expect(() =>
      validateProductConversion(existing, { fromUnitId: "CASE", toUnitId: "L", factor: "12" }),
    ).toThrow(/already converts/);
    expect(() =>
      validateProductConversion(existing, { fromUnitId: "L", toUnitId: "CASE", factor: "0.1" }),
    ).toThrow(/loop/);
    expect(() =>
      validateProductConversion(existing, { fromUnitId: "PACK", toUnitId: "BOTTLE", factor: "0" }),
    ).toThrow(/positive/);
    expect(() =>
      validateProductConversion(existing, { fromUnitId: "PACK", toUnitId: "BOTTLE", factor: "1.0000001" }),
    ).toThrow(/six decimal/);
    // Editing an existing conversion doesn't collide with itself.
    expect(() =>
      validateProductConversion(existing, { id: "1", fromUnitId: "CASE", toUnitId: "BOTTLE", factor: "24" }),
    ).not.toThrow();
  });
});

describe("weighted-average cost", () => {
  it("10 @ 2.0000 + receive 10 @ 3.0000 -> 2.5000", () => {
    expect(
      nextAverageCost({ quantityBefore: "10", averageBefore: "2.0000", quantityIn: "10", totalCostIn: "30" }),
    ).toBe("2.5000");
  });

  it("lets the receipt cost establish the average from zero", () => {
    expect(
      nextAverageCost({ quantityBefore: "0", averageBefore: null, quantityIn: "4", totalCostIn: "10" }),
    ).toBe("2.5000");
  });

  it("rounds ROUND_HALF_UP to four places and uses the persisted value next time", () => {
    // (1 * 1.0000 + 2 * 1.00005) / 3 = 1.0000333.. -> 1.0000
    const first = nextAverageCost({ quantityBefore: "1", averageBefore: "1.0000", quantityIn: "2", totalCostIn: "2.0001" });

    expect(first).toBe("1.0000");
    // Exactly half: (1 * 1.0000 + 1 * 1.0001) / 2 = 1.00005 -> 1.0001
    expect(
      nextAverageCost({ quantityBefore: "1", averageBefore: "1.0000", quantityIn: "1", totalCostIn: "1.0001" }),
    ).toBe("1.0001");
    // The next receipt averages against the persisted 1.0000, not a hidden 1.0000333.
    expect(
      nextAverageCost({ quantityBefore: "3", averageBefore: first, quantityIn: "1", totalCostIn: "1.0000" }),
    ).toBe("1.0000");
  });

  it("handles multiple receipts and high-precision base-unit costs", () => {
    let average: string | null = null;
    let quantity = "0";

    for (const [inQuantity, cost] of [
      ["12000", "27.99"],
      ["12000", "29.49"],
    ] as const) {
      average = nextAverageCost({ quantityBefore: quantity, averageBefore: average, quantityIn: inQuantity, totalCostIn: cost });
      quantity = String(Number(quantity) + Number(inQuantity));
    }

    // (12000 * 0.0023 + 29.49) / 24000 = 0.0023787.. -> 0.0024
    expect(average).toBe("0.0024");
    expect(baseUnitCost("27.99", "12000")).toBe("0.0023");
    expect(extendCost("2.5", "1.23456")).toBe("3.0864");
  });

  it("keeps the average while a receipt leaves QOH at or below zero", () => {
    expect(
      nextAverageCost({ quantityBefore: "-10", averageBefore: "2.0000", quantityIn: "4", totalCostIn: "20" }),
    ).toBe("2.0000");
    expect(
      nextAverageCost({ quantityBefore: "-4", averageBefore: "2.0000", quantityIn: "4", totalCostIn: "20" }),
    ).toBe("2.0000");
  });

  it("uses the receipt's base-unit cost when it lifts QOH above zero", () => {
    expect(
      nextAverageCost({ quantityBefore: "-2", averageBefore: "2.0000", quantityIn: "6", totalCostIn: "30" }),
    ).toBe("5.0000");
  });

  it("uses the receipt cost when stock exists with no cost basis", () => {
    expect(
      nextAverageCost({ quantityBefore: "5", averageBefore: null, quantityIn: "5", totalCostIn: "15" }),
    ).toBe("3.0000");
  });
});

describe("stock policy", () => {
  const post = (type: Parameters<typeof assertStockPolicy>[0]["type"], before: string, delta: string, allowNegative = false) =>
    assertStockPolicy({ type, quantityBefore: before, baseQuantityDelta: delta, allowNegative });

  it("returns the exact resulting balance", () => {
    expect(post("RECEIVE", "10.0000", "2.5000")).toBe("12.5000");
    expect(post("WASTE", "10.0000", "-10.0000")).toBe("0.0000");
  });

  it("refuses anything below zero by default, consumption included", () => {
    for (const type of ["CONSUME", "WASTE", "ADJUST_DECREASE", "COUNT_DECREASE", "TRANSFER_OUT"] as const) {
      expect(() => post(type, "1", "-2")).toThrow(/enough stock/);
    }
  });

  it("lets only CONSUME go negative when the location allows it", () => {
    expect(post("CONSUME", "1", "-2", true)).toBe("-1");
    for (const type of ["WASTE", "ADJUST_DECREASE", "COUNT_DECREASE", "TRANSFER_OUT"] as const) {
      expect(() => post(type, "1", "-2", true)).toThrow(/enough stock/);
    }
  });

  it("always allows increases, even from a negative balance", () => {
    expect(post("RECEIVE", "-5", "2")).toBe("-3");
    expect(post("ADJUST_INCREASE", "-5", "1")).toBe("-4");
  });

  it("enforces each type's direction and refuses zero", () => {
    expect(() => assertDirection("WASTE", "1")).toThrow(/must remove/);
    expect(() => assertDirection("RECEIVE", "-1")).toThrow(/must add/);
    expect(() => assertDirection("CONSUME", "0")).toThrow(/not be zero/);
    for (const [type, delta] of [
      ["RECEIVE", "1"],
      ["CONSUME", "-1"],
      ["WASTE", "-1"],
      ["ADJUST_INCREASE", "1"],
      ["ADJUST_DECREASE", "-1"],
      ["COUNT_INCREASE", "1"],
      ["COUNT_DECREASE", "-1"],
      ["TRANSFER_OUT", "-1"],
      ["TRANSFER_IN", "1"],
    ] as const) {
      expect(() => assertDirection(type, delta)).not.toThrow();
    }
  });
});

describe("purchasing", () => {
  it("computes exact line and order totals", () => {
    expect(lineTotal("10", "27.9900")).toBe("279.9000");
    expect(lineTotal("3.5", "1.23456")).toBe("4.3210");
    expect(orderTotal(["279.9000", "4.3210", "0.0001"])).toBe("284.2211");
  });

  it("tracks the remaining quantity and refuses over-receiving", () => {
    expect(remainingQuantity("10", "6")).toBe("4");
    expect(() => assertReceivable({ ordered: "10", receivedSoFar: "6", receiving: "4" })).not.toThrow();
    expect(() => assertReceivable({ ordered: "10", receivedSoFar: "6", receiving: "4.0001" })).toThrow(/Over-receiving/);
    expect(() => assertReceivable({ ordered: "10", receivedSoFar: "0", receiving: "0" })).toThrow(/positive/);
  });

  it("moves to partially received, then received", () => {
    expect(statusAfterReceipt([{ ordered: "10", received: "6" }])).toBe("PARTIALLY_RECEIVED");
    expect(statusAfterReceipt([{ ordered: "10", received: "10" }, { ordered: "2", received: "2" }])).toBe("RECEIVED");
    expect(statusAfterReceipt([{ ordered: "10", received: "10" }, { ordered: "2", received: "0" }])).toBe("PARTIALLY_RECEIVED");
  });

  it("allows only the approved status transitions", () => {
    expect(() => assertTransition("DRAFT", "SUBMITTED")).not.toThrow();
    expect(() => assertTransition("SUBMITTED", "CANCELLED")).not.toThrow();
    expect(() => assertTransition("RECEIVED", "CANCELLED")).toThrow();
    expect(() => assertTransition("CANCELLED", "SUBMITTED")).toThrow();
    expect(() => assertTransition("DRAFT", "RECEIVED")).toThrow();
    expect(canReceive("DRAFT")).toBe(false);
    expect(canReceive("PARTIALLY_RECEIVED")).toBe(true);
    expect(canReceive("CANCELLED")).toBe(false);
    expect(formatPoNumber(42)).toBe("PO-000042");
  });
});

describe("counts", () => {
  it("computes variance against the snapshot", () => {
    expect(variance("8.0000", "10.0000")).toBe("-2.0000");
    expect(variance("12", "10")).toBe("2");
    expect(variance("10", "10")).toBe("0");
  });

  it("maps variance to the posting type", () => {
    expect(variancePosting("2.0000")).toEqual({ type: "COUNT_INCREASE", magnitude: "2.0000" });
    expect(variancePosting("-2.0000")).toEqual({ type: "COUNT_DECREASE", magnitude: "2.0000" });
    expect(variancePosting("0.0000")).toBeNull();
  });

  it("requires a submitted, complete count, and acknowledgement of later activity", () => {
    const base = { status: "SUBMITTED" as const, uncountedLines: 0, linesWithActivity: 0, acknowledgeActivity: false };

    expect(() => assertApprovable(base)).not.toThrow();
    expect(() => assertApprovable({ ...base, status: "APPROVED" })).toThrow(/already been approved/);
    expect(() => assertApprovable({ ...base, status: "DRAFT" })).toThrow(/submitted/);
    expect(() => assertApprovable({ ...base, uncountedLines: 1 })).toThrow(/counted quantity/);
    expect(() => assertApprovable({ ...base, linesWithActivity: 2 })).toThrow(/acknowledge/);
    expect(() => assertApprovable({ ...base, linesWithActivity: 2, acknowledgeActivity: true })).not.toThrow();
    expect(() => assertCountTransition("APPROVED", "CANCELLED")).toThrow();
  });
});

describe("replenishment", () => {
  const thresholds = { parLevel: "20", reorderLevel: "5", reorderTarget: "15" };

  it("excludes stock above the reorder level and includes it at or below", () => {
    expect(evaluateStock("6", thresholds).low).toBe(false);
    expect(evaluateStock("5", thresholds)).toMatchObject({ low: true, suggestedQuantity: "10.0000" });
    expect(evaluateStock("2.5", thresholds)).toMatchObject({ low: true, suggestedQuantity: "12.5000", shortageToPar: "17.5000" });
  });

  it("handles negative QOH without overstating stock", () => {
    expect(evaluateStock("-3", thresholds)).toMatchObject({ low: true, suggestedQuantity: "18.0000" });
  });

  it("falls back to par when there is no target, and has nothing to suggest without a level", () => {
    expect(evaluateStock("5", { parLevel: "20", reorderLevel: "5", reorderTarget: null }).suggestedQuantity).toBe("15.0000");
    expect(evaluateStock("0", { parLevel: null, reorderLevel: null, reorderTarget: null })).toEqual({
      low: false,
      shortageToPar: null,
      suggestedQuantity: null,
    });
  });

  it("validates threshold relationships", () => {
    expect(() => assertThresholds(thresholds)).not.toThrow();
    expect(() => assertThresholds({ ...thresholds, reorderLevel: "-1" })).toThrow(/negative/);
    expect(() => assertThresholds({ ...thresholds, reorderLevel: "25" })).toThrow(/above the par/);
    expect(() => assertThresholds({ ...thresholds, reorderTarget: "4" })).toThrow(/below the reorder/);
  });
});

describe("low-stock alert crossings (Phase 19 policy 12)", () => {
  it("opens on the way down to or below the level, resolves on the way above", () => {
    expect(alertCrossing("51", "50", "50")).toBe("OPEN");
    expect(alertCrossing("60", "-2", "50")).toBe("OPEN");
    expect(alertCrossing("50", "49", "50")).toBe("NONE");
    expect(alertCrossing("45", "50", "50")).toBe("NONE");
    expect(alertCrossing("50", "50.0001", "50")).toBe("RESOLVE");
    expect(alertCrossing("60", "55", "50")).toBe("NONE");
    expect(alertCrossing("60", "0", null)).toBe("NONE");
  });
});

describe("suggested purchase lines (Phase 19 policy 16)", () => {
  const thresholds = { parLevel: "100.0000", reorderLevel: "20.0000", reorderTarget: "90.0000" };
  const preferred = { supplierItemId: "si-1", supplierId: "sup-1", baseUnitsPerPurchase: "12.0000" };

  it("subtracts what's on order and rounds up to whole purchase units", () => {
    const { bySupplier } = suggestPurchaseLines([
      { inventoryItemId: "a", quantityOnHand: "10.0000", thresholds, outstandingBaseQuantity: "24.0000", preferred },
    ]);

    // Suggest 90 - 10 = 80; minus 24 on order = 56; 56 / 12 = 4.67 -> 5 cases.
    expect(bySupplier.get("sup-1")).toEqual([
      { inventoryItemId: "a", supplierItemId: "si-1", supplierId: "sup-1", needBaseQuantity: "56.0000", orderedQuantity: "5" },
    ]);
  });

  it("skips items that aren't low or are already covered, and lists those with no supplier", () => {
    const result = suggestPurchaseLines([
      { inventoryItemId: "high", quantityOnHand: "30", thresholds, outstandingBaseQuantity: "0", preferred },
      { inventoryItemId: "covered", quantityOnHand: "10", thresholds, outstandingBaseQuantity: "80", preferred },
      { inventoryItemId: "orphan", quantityOnHand: "5", thresholds, outstandingBaseQuantity: "0", preferred: null },
    ]);

    expect(result.bySupplier.size).toBe(0);
    expect(result.withoutSupplier).toEqual([{ inventoryItemId: "orphan", needBaseQuantity: "85.0000" }]);
  });

  it("groups lines by supplier", () => {
    const other = { supplierItemId: "si-2", supplierId: "sup-2", baseUnitsPerPurchase: "1.0000" };
    const result = suggestPurchaseLines([
      { inventoryItemId: "a", quantityOnHand: "0", thresholds, outstandingBaseQuantity: "0", preferred },
      { inventoryItemId: "b", quantityOnHand: "0", thresholds, outstandingBaseQuantity: "0", preferred: other },
      { inventoryItemId: "c", quantityOnHand: "0", thresholds, outstandingBaseQuantity: "0", preferred: { ...preferred, supplierItemId: "si-3" } },
    ]);

    expect([...result.bySupplier.keys()]).toEqual(["sup-1", "sup-2"]);
    expect(result.bySupplier.get("sup-1")!.map((line) => line.orderedQuantity)).toEqual(["8", "8"]);
    expect(result.bySupplier.get("sup-2")![0]!.orderedQuantity).toBe("90");
  });
});
