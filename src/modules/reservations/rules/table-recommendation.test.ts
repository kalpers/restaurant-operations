import { describe, expect, it } from "vitest";

import {
  recommendTables,
  type RecommendableTable,
} from "./table-recommendation";
import { estimateWait, type EstimateTable } from "./wait-estimate";

let counter = 0;

function table(
  tableNumber: string,
  capacity: number,
  overrides: Partial<RecommendableTable> = {},
): RecommendableTable {
  counter += 1;

  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    tableNumber,
    capacity,
    areaId: "dining",
    areaName: "Dining Room",
    availability: "AVAILABLE",
    heldForOtherParty: false,
    ...overrides,
  };
}

const numbers = (result: ReturnType<typeof recommendTables>) =>
  result.recommendations.map((entry) => entry.tableNumbers.join("+"));

describe("recommendTables", () => {
  it("prefers the smallest adequate table", () => {
    const result = recommendTables({
      partySize: 3,
      tables: [table("T01", 6), table("T02", 4), table("T03", 2)],
    });

    expect(numbers(result)[0]).toBe("T02");
    expect(result.recommendations[0]!.surplus).toBe(1);
    expect(result.recommendations[0]!.reasons).toContain("SINGLE_TABLE");
  });

  it("marks an exact fit", () => {
    const result = recommendTables({ partySize: 4, tables: [table("T01", 4)] });

    expect(result.recommendations[0]!.reasons).toContain("EXACT_FIT");
  });

  it("lists single tables before combinations", () => {
    const result = recommendTables({
      partySize: 4,
      tables: [table("T01", 2), table("T02", 2), table("T03", 6)],
    });

    expect(numbers(result)).toEqual(["T03", "T01+T02"]);
    expect(result.recommendations[1]!.reasons).toContain("COMBINED_TABLES");
  });

  it("suggests a combination only when no table seats the party", () => {
    const result = recommendTables({
      partySize: 6,
      tables: [table("T01", 4), table("T02", 4), table("T03", 2)],
    });

    expect(numbers(result)[0]).toBe("T01+T03");
    expect(numbers(result)).toContain("T01+T02");
  });

  it("prefers fewer tables in a combination", () => {
    const result = recommendTables({
      partySize: 8,
      tables: [table("T01", 4), table("T02", 4), table("T03", 2), table("T04", 2), table("T05", 2)],
    });

    expect(numbers(result)[0]).toBe("T01+T02");
  });

  it("never combines more than three tables", () => {
    const result = recommendTables({
      partySize: 8,
      tables: [table("T01", 2), table("T02", 2), table("T03", 2), table("T04", 2)],
    });

    expect(result.recommendations).toEqual([]);
  });

  it("allows exactly three tables", () => {
    const result = recommendTables({
      partySize: 6,
      tables: [table("T01", 2), table("T02", 2), table("T03", 2), table("T04", 2)],
    });

    expect(numbers(result)[0]).toBe("T01+T02+T03");
    expect(result.recommendations.every((entry) => entry.tableIds.length <= 3)).toBe(
      true,
    );
  });

  it("never combines tables across areas", () => {
    const result = recommendTables({
      partySize: 4,
      tables: [
        table("T01", 2),
        table("B01", 2, { areaId: "bar", areaName: "Bar" }),
      ],
    });

    expect(result.recommendations).toEqual([]);
  });

  it("excludes tables that can't be seated, with a reason", () => {
    const dirty = table("T01", 4, { availability: "DIRTY" });
    const out = table("T02", 4, { availability: "OUT_OF_SERVICE" });
    const occupied = table("T03", 4, { availability: "OCCUPIED" });
    const inactive = table("T04", 4, { availability: "INACTIVE" });
    const held = table("T05", 4, { heldForOtherParty: true });
    const result = recommendTables({
      partySize: 2,
      tables: [dirty, out, occupied, inactive, held],
    });

    expect(result.recommendations).toEqual([]);
    expect(result.excluded.map((entry) => [entry.tableNumber, entry.reason])).toEqual([
      ["T01", "DIRTY"],
      ["T02", "OUT_OF_SERVICE"],
      ["T03", "OCCUPIED"],
      ["T04", "INACTIVE"],
      ["T05", "RESERVATION_HOLD"],
    ]);
  });

  it("puts the preferred area first, then explains the rest", () => {
    const result = recommendTables({
      partySize: 2,
      preferredAreaId: "bar",
      tables: [
        table("T01", 2),
        table("B01", 4, { areaId: "bar", areaName: "Bar" }),
      ],
    });

    expect(numbers(result)).toEqual(["B01", "T01"]);
    expect(result.recommendations[0]!.reasons).toContain("IN_PREFERRED_AREA");
    expect(result.recommendations[1]!.reasons).toContain("OUTSIDE_PREFERRED_AREA");
  });

  it("breaks ties by natural table number, then ID, whatever the input order", () => {
    const tables = [table("T10", 4), table("T2", 4), table("T1", 4)];
    const forward = recommendTables({ partySize: 4, tables });
    const reversed = recommendTables({ partySize: 4, tables: [...tables].reverse() });

    expect(numbers(forward)).toEqual(["T1", "T2", "T10"]);
    expect(reversed).toEqual(forward);
  });

  it("breaks a table number tie by ID", () => {
    const a = table("T01", 4, { areaId: "a" });
    const b = table("T01", 4, { areaId: "b" });
    const result = recommendTables({ partySize: 4, tables: [b, a] });

    expect(result.recommendations.map((entry) => entry.tableIds[0])).toEqual([
      a.id,
      b.id,
    ]);
  });
});

describe("estimateWait", () => {
  function estimateTable(
    tableNumber: string,
    capacity: number,
    overrides: Partial<EstimateTable> = {},
  ): EstimateTable {
    return {
      ...table(tableNumber, capacity),
      occupiedForMinutes: null,
      holdEndsInMinutes: null,
      ...overrides,
    };
  }

  it("is zero when a suitable table is free now", () => {
    const estimate = estimateWait({
      partySize: 2,
      partiesAhead: [],
      turnMinutes: 90,
      tables: [estimateTable("T01", 4)],
    });

    expect(estimate.minutes).toBe(0);
    expect(estimate.basis).toBe("TABLE_AVAILABLE_NOW");
  });

  it("is positive when every suitable table is occupied", () => {
    const estimate = estimateWait({
      partySize: 4,
      partiesAhead: [],
      turnMinutes: 90,
      tables: [
        estimateTable("T01", 4, { availability: "OCCUPIED", occupiedForMinutes: 60 }),
        estimateTable("T02", 4, { availability: "OCCUPIED", occupiedForMinutes: 30 }),
      ],
    });

    expect(estimate.minutes).toBe(30);
    expect(estimate.basis).toBe("EARLIEST_TABLE_TURN");
  });

  it("allows a minimum for a party that has overstayed", () => {
    const estimate = estimateWait({
      partySize: 2,
      partiesAhead: [],
      turnMinutes: 90,
      tables: [
        estimateTable("T01", 2, { availability: "OCCUPIED", occupiedForMinutes: 200 }),
      ],
    });

    expect(estimate.minutes).toBe(5);
  });

  it("is influenced by an active reservation hold", () => {
    const estimate = estimateWait({
      partySize: 2,
      partiesAhead: [],
      turnMinutes: 90,
      tables: [estimateTable("T01", 4, { holdEndsInMinutes: 20 })],
    });

    expect(estimate.minutes).toBe(20);
  });

  it("gives parties ahead the earliest tables first", () => {
    const tables = [
      estimateTable("T01", 4),
      estimateTable("T02", 4, { availability: "OCCUPIED", occupiedForMinutes: 45 }),
    ];

    expect(
      estimateWait({ partySize: 4, partiesAhead: [], turnMinutes: 90, tables })
        .minutes,
    ).toBe(0);
    expect(
      estimateWait({ partySize: 4, partiesAhead: [4], turnMinutes: 90, tables })
        .minutes,
    ).toBe(45);
  });

  it("says so when nothing could seat the party", () => {
    const estimate = estimateWait({
      partySize: 20,
      partiesAhead: [],
      turnMinutes: 90,
      tables: [estimateTable("T01", 4)],
    });

    expect(estimate.minutes).toBeNull();
    expect(estimate.basis).toBe("NO_SUITABLE_TABLE");
  });
});
