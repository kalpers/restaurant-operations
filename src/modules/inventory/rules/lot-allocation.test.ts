import { describe, expect, it } from "vitest";

import { allocateFromLots, expiryStatus, fefoOrder, settleShortfalls, totalAllocated } from "./lot-allocation";

const lot = (id: string, expiresOn: string | null, receivedOn: string, sequenceNumber: number, quantityRemaining: string) => ({
  id,
  expiresOn,
  receivedOn,
  sequenceNumber,
  quantityRemaining,
});

describe("fefoOrder", () => {
  it("puts dated lots first by expiry, then undated, then by received date and number", () => {
    const lots = [
      lot("undated-old", null, "2026-01-01", 1, "1"),
      lot("late", "2026-12-01", "2026-01-02", 2, "1"),
      lot("soon-b", "2026-11-20", "2026-01-05", 4, "1"),
      lot("soon-a", "2026-11-20", "2026-01-03", 3, "1"),
      lot("undated-new", null, "2026-02-01", 5, "1"),
    ];

    expect(fefoOrder(lots).map((entry) => entry.id)).toEqual(["soon-a", "soon-b", "late", "undated-old", "undated-new"]);
  });
});

describe("allocateFromLots", () => {
  const lots = [lot("a", "2026-11-20", "2026-11-01", 1, "3.0000"), lot("b", "2026-11-25", "2026-11-02", 2, "5.0000")];

  it("takes the first to expire first and spills into the next", () => {
    const { allocations, shortfall } = allocateFromLots({ lots, quantity: "4.5", allowShortfall: false });

    expect(allocations).toEqual([
      { lotId: "a", quantity: "3.0000" },
      { lotId: "b", quantity: "1.5000" },
    ]);
    expect(totalAllocated(allocations)).toBe("4.5000");
    expect(shortfall).toBe("0");
  });

  it("uses a named lot alone, and refuses one that holds too little", () => {
    expect(allocateFromLots({ lots, quantity: "2", namedLotId: "b", allowShortfall: false }).allocations).toEqual([
      { lotId: "b", quantity: "2" },
    ]);
    expect(() => allocateFromLots({ lots, quantity: "4", namedLotId: "a", allowShortfall: false })).toThrow(
      expect.objectContaining({ code: "LOT_INSUFFICIENT" }),
    );
  });

  it("leaves a shortfall only when allowed", () => {
    expect(allocateFromLots({ lots, quantity: "10", allowShortfall: true }).shortfall).toBe("2.0000");
    expect(() => allocateFromLots({ lots, quantity: "10", allowShortfall: false })).toThrow(
      expect.objectContaining({ code: "LOTS_OUT_OF_BALANCE" }),
    );
  });

  it("skips empty lots", () => {
    expect(
      allocateFromLots({ lots: [lot("empty", "2026-01-01", "2026-01-01", 1, "0.0000"), ...lots], quantity: "1", allowShortfall: false })
        .allocations,
    ).toEqual([{ lotId: "a", quantity: "1" }]);
  });
});

describe("settleShortfalls", () => {
  it("settles the oldest shortfall first and returns what is left", () => {
    const { settlements, rest } = settleShortfalls(
      [
        { movementId: "m1", transactionId: "t1", open: "2.0000" },
        { movementId: "m2", transactionId: "t2", open: "3.0000" },
      ],
      "4",
    );

    expect(settlements.map((entry) => [entry.movementId, entry.quantity])).toEqual([
      ["m1", "2.0000"],
      ["m2", "2.0000"],
    ]);
    expect(rest).toBe("0.0000");
  });
});

describe("expiryStatus", () => {
  it("is expired after the date, expiring inside the window, and OK otherwise", () => {
    expect(expiryStatus("2026-11-10", "2026-11-11", 2)).toBe("EXPIRED");
    expect(expiryStatus("2026-11-12", "2026-11-11", 2)).toBe("EXPIRING");
    expect(expiryStatus("2026-11-11", "2026-11-11", 2)).toBe("EXPIRING");
    expect(expiryStatus("2026-11-20", "2026-11-11", 2)).toBe("OK");
    expect(expiryStatus("2026-11-12", "2026-11-11", 0)).toBe("OK");
    expect(expiryStatus(null, "2026-11-11", 2)).toBe("OK");
  });
});
