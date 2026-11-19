import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import { assertSeatAllowed, planSplitBySeat, seatLabel, seatSubtotals, validateSeat } from "./seats";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof AppError ? error.code : "OTHER";
  }

  return undefined;
}

describe("validateSeat", () => {
  it("accepts 1 to 30 and null", () => {
    expect(validateSeat(1)).toBe(1);
    expect(validateSeat(30)).toBe(30);
    expect(validateSeat(null)).toBeNull();
  });

  it("refuses anything else", () => {
    for (const seat of [0, 31, -1, 2.5, Number.NaN]) {
      expect(codeOf(() => validateSeat(seat))).toBe("INVALID_SEAT");
    }
  });
});

describe("assertSeatAllowed", () => {
  it("allows dine-in and bar checks at a session", () => {
    expect(codeOf(() => assertSeatAllowed({ orderType: "DINE_IN", tableSessionId: "s" }))).toBeUndefined();
    expect(codeOf(() => assertSeatAllowed({ orderType: "BAR", tableSessionId: "s" }))).toBeUndefined();
  });

  it("refuses takeout and checks with no session", () => {
    expect(codeOf(() => assertSeatAllowed({ orderType: "TAKEOUT", tableSessionId: null }))).toBe("SEAT_NOT_ALLOWED");
    expect(codeOf(() => assertSeatAllowed({ orderType: "BAR", tableSessionId: null }))).toBe("SEAT_NOT_ALLOWED");
  });
});

describe("planSplitBySeat", () => {
  const item = (id: string, seatNumber: number | null, status = "SUBMITTED") => ({ id, seatNumber, status });

  it("keeps the lowest seat and Table items, and moves each other seat in order", () => {
    const plan = planSplitBySeat([
      item("c", 3),
      item("t", null),
      item("a", 1),
      item("b2", 2, "DRAFT"),
      item("b1", 2),
      item("d", 5),
      item("s", 4, "SPLIT"),
    ]);

    expect(plan).toEqual({
      stayingSeat: 1,
      moves: [
        { seat: 2, itemIds: ["b1", "b2"] },
        { seat: 3, itemIds: ["c"] },
        { seat: 5, itemIds: ["d"] },
      ],
    });
  });

  it("never moves a shared original", () => {
    expect(codeOf(() => planSplitBySeat([item("a", 1), item("s", 2, "SPLIT")]))).toBe("NOTHING_TO_SPLIT");
  });

  it("ignores voided items", () => {
    expect(codeOf(() => planSplitBySeat([item("a", 1), item("v", 2, "VOIDED")]))).toBe("NOTHING_TO_SPLIT");
    expect(planSplitBySeat([item("a", 1), item("v", 2, "VOIDED"), item("b", 3)]).moves).toEqual([
      { seat: 3, itemIds: ["b"] },
    ]);
  });

  it("refuses fewer than two seats", () => {
    expect(codeOf(() => planSplitBySeat([]))).toBe("NOTHING_TO_SPLIT");
    expect(codeOf(() => planSplitBySeat([item("a", 2), item("b", 2), item("t", null)]))).toBe("NOTHING_TO_SPLIT");
  });
});

describe("seatSubtotals", () => {
  it("sums per seat with Table last", () => {
    expect(
      seatSubtotals([
        { seatNumber: null, amount: "9.00" },
        { seatNumber: 2, amount: "12.50" },
        { seatNumber: 1, amount: "3.10" },
        { seatNumber: 2, amount: "0.25" },
      ]),
    ).toEqual([
      { seat: 1, amount: "3.10", lineCount: 1 },
      { seat: 2, amount: "12.75", lineCount: 2 },
      { seat: null, amount: "9.00", lineCount: 1 },
    ]);
  });

  it("is empty for no lines", () => {
    expect(seatSubtotals([])).toEqual([]);
  });
});

describe("seatLabel", () => {
  it("labels seats and Table", () => {
    expect(seatLabel(4)).toBe("S4");
    expect(seatLabel(null)).toBe("Table");
  });
});
