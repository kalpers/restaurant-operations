import { describe, expect, it } from "vitest";

import {
  averageFromLots,
  averageOnHand,
  carryOverToLots,
  onHandUnitCost,
  shortfallUnitCost,
  splitArrivingValue,
  sumKnown,
  unitCostOf,
  valueTaken,
} from "./lot-costing";

describe("Phase 37 lot costing rules", () => {
  describe("valueTaken", () => {
    const lot = { quantityRemaining: "12000.0000", carryingUnitCost: "0.0023", valueRemaining: "27.9900" };

    it("takes quantity x carrying cost, half-up to four places, for part of a lot", () => {
      expect(valueTaken(lot, "30")).toBe("0.0690");
      expect(valueTaken({ ...lot, carryingUnitCost: "0.00233" }, "15")).toBe("0.0350");
    });

    it("takes everything that remains when the rest of the lot is taken, so value ends with quantity", () => {
      expect(valueTaken(lot, "12000")).toBe("27.9900");
      expect(valueTaken(lot, "13000")).toBe("27.9900");
    });

    it("never takes more than the lot holds", () => {
      expect(valueTaken({ quantityRemaining: "10", carryingUnitCost: "1.0000", valueRemaining: "5.0000" }, "9")).toBe("5.0000");
    });

    it("moves no value for a lot with no cost", () => {
      expect(valueTaken({ quantityRemaining: "10", carryingUnitCost: null, valueRemaining: null }, "4")).toBeNull();
      expect(valueTaken({ quantityRemaining: "10", carryingUnitCost: null, valueRemaining: "3.0000" }, "4")).toBeNull();
    });
  });

  it("sums known costs and is null only when none is known", () => {
    expect(sumKnown(["1.0000", null, "2.5000"])).toBe("3.5000");
    expect(sumKnown([null, null])).toBeNull();
    expect(sumKnown([])).toBeNull();
  });

  it("works out a display unit cost from a total", () => {
    expect(unitCostOf("10.0000", "3")).toBe("3.3333");
    expect(unitCostOf(null, "3")).toBeNull();
    expect(unitCostOf("1.0000", "0")).toBeNull();
  });

  it("costs a shortfall at the last lot taken, else the latest lot received, else nothing (D6)", () => {
    expect(shortfallUnitCost("0.5000", "0.7000")).toBe("0.5000");
    expect(shortfallUnitCost(null, "0.7000")).toBe("0.7000");
    expect(shortfallUnitCost(null, null)).toBeNull();
  });

  it("costs found stock at the on-hand cost, else the latest lot, else nothing (D5)", () => {
    expect(onHandUnitCost({ quantityOnHand: "4", stockValue: "10.0000", latestLotCarrying: "9.0000" })).toBe("2.5000");
    expect(onHandUnitCost({ quantityOnHand: "0", stockValue: "0.0000", latestLotCarrying: "9.0000" })).toBe("9.0000");
    expect(onHandUnitCost({ quantityOnHand: "-2", stockValue: "-1.0000", latestLotCarrying: null })).toBeNull();
  });

  it("shows the average on hand, unchanged while nothing is on hand (D8)", () => {
    expect(averageOnHand("10.0000", "4", "1.0000")).toBe("2.5000");
    expect(averageOnHand("0.0000", "0", "1.0000")).toBe("1.0000");
    expect(averageOnHand("-3.0000", "-1", null)).toBeNull();
  });

  describe("switching method (D3)", () => {
    it("carries open lots at the current average", () => {
      const carried = carryOverToLots(
        [
          { id: "a", quantityRemaining: "3" },
          { id: "b", quantityRemaining: "1.5" },
        ],
        "2.3333",
      );

      expect(carried).toEqual([
        { id: "a", quantityRemaining: "3", carryingUnitCost: "2.3333", valueRemaining: "6.9999" },
        { id: "b", quantityRemaining: "1.5", carryingUnitCost: "2.3333", valueRemaining: "3.5000" },
      ]);
    });

    it("leaves lots uncosted when there is no average", () => {
      expect(carryOverToLots([{ quantityRemaining: "2" }], null)).toEqual([
        { quantityRemaining: "2", carryingUnitCost: null, valueRemaining: null },
      ]);
    });

    it("sets the average back from the lots' value", () => {
      expect(averageFromLots("10.0000", "3", "1.0000")).toBe("3.3333");
      expect(averageFromLots(null, "3", "1.0000")).toBe("1.0000");
      expect(averageFromLots("0.0000", "0", "1.0000")).toBe("1.0000");
    });
  });

  describe("arriving transfer value (D7)", () => {
    it("keeps each lot's value and adjusts the last so the total is exactly the value sent", () => {
      expect(
        splitArrivingValue({
          pieces: [
            { quantity: "2", value: "3.0000" },
            { quantity: "1", value: "1.3334" },
          ],
          restQuantity: "0",
          valueSent: "4.3333",
          unitCostSent: "1.4444",
        }),
      ).toEqual({ pieces: ["3.0000", "1.3333"], rest: null });
    });

    it("gives the found remainder whatever the lots don't cover", () => {
      expect(
        splitArrivingValue({
          pieces: [{ quantity: "2", value: "3.0000" }],
          restQuantity: "1",
          valueSent: "5.0000",
          unitCostSent: "1.6667",
        }),
      ).toEqual({ pieces: ["3.0000"], rest: "2.0000" });
    });

    it("values pieces without a cost at the sent unit cost", () => {
      expect(
        splitArrivingValue({
          pieces: [{ quantity: "2", value: null }],
          restQuantity: "0",
          valueSent: null,
          unitCostSent: "1.5000",
        }),
      ).toEqual({ pieces: ["3.0000"], rest: null });
    });
  });
});
