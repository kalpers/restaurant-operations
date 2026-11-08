import { MAX_COMBINED_TABLES } from "../types";

/** What the recommender needs to know about a table. No guest or HR data. */
export type RecommendableTable = {
  id: string;
  tableNumber: string;
  capacity: number;
  areaId: string;
  areaName: string;
  /** Phase 5's derived label: only AVAILABLE tables can be recommended. */
  availability: "AVAILABLE" | "DIRTY" | "OUT_OF_SERVICE" | "OCCUPIED" | "INACTIVE";
  /** An active reservation hold for another party. */
  heldForOtherParty: boolean;
};

export type RecommendationReason =
  | "SINGLE_TABLE"
  | "COMBINED_TABLES"
  | "IN_PREFERRED_AREA"
  | "OUTSIDE_PREFERRED_AREA"
  | "EXACT_FIT";

export type Recommendation = {
  tableIds: string[];
  tableNumbers: string[];
  areaId: string;
  areaName: string;
  capacity: number;
  /** Seats beyond the party size. */
  surplus: number;
  reasons: RecommendationReason[];
};

export type ExclusionReason =
  | "OCCUPIED"
  | "DIRTY"
  | "OUT_OF_SERVICE"
  | "INACTIVE"
  | "RESERVATION_HOLD";

export type RecommendationResult = {
  recommendations: Recommendation[];
  excluded: { tableId: string; tableNumber: string; reason: ExclusionReason }[];
};

const MAX_RESULTS = 10;

/** "T2" before "T10", and the same answer every time. */
export function compareTableNumbers(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function compareTables(
  left: RecommendableTable,
  right: RecommendableTable,
): number {
  return (
    compareTableNumbers(left.tableNumber, right.tableNumber) ||
    left.id.localeCompare(right.id)
  );
}

export function exclusionReason(
  table: RecommendableTable,
): ExclusionReason | null {
  switch (table.availability) {
    case "AVAILABLE":
      return table.heldForOtherParty ? "RESERVATION_HOLD" : null;
    default:
      return table.availability;
  }
}

/**
 * Every set of one to three eligible tables in one area that seats the party and has no
 * table it could do without. Sets are returned smallest first.
 */
export function candidateSets(
  partySize: number,
  tables: readonly RecommendableTable[],
): RecommendableTable[][] {
  const byArea = new Map<string, RecommendableTable[]>();

  for (const table of [...tables].sort(compareTables)) {
    byArea.set(table.areaId, [...(byArea.get(table.areaId) ?? []), table]);
  }

  const sets: RecommendableTable[][] = [];

  for (const areaTables of byArea.values()) {
    const grow = (
      start: number,
      chosen: RecommendableTable[],
      capacity: number,
    ) => {
      if (chosen.length > 0 && capacity >= partySize) {
        const smallest = Math.min(...chosen.map((table) => table.capacity));

        // A set that still seats the party without one table isn't minimal.
        if (chosen.length === 1 || capacity - smallest < partySize) {
          sets.push(chosen);
        }

        return;
      }

      if (chosen.length === MAX_COMBINED_TABLES) {
        return;
      }

      for (let index = start; index < areaTables.length; index += 1) {
        const table = areaTables[index]!;

        grow(index + 1, [...chosen, table], capacity + table.capacity);
      }
    };

    grow(0, [], 0);
  }

  return sets;
}

/**
 * Ranked table suggestions for a party. It is a pure function of its inputs: it reserves
 * nothing and seats nothing, and the host chooses.
 *
 * Ranking, in order: one table before a combination, then fewer tables, then the
 * preferred area, then the smallest surplus of seats, then table numbers and IDs.
 */
export function recommendTables(input: {
  partySize: number;
  tables: readonly RecommendableTable[];
  preferredAreaId?: string | null;
}): RecommendationResult {
  const excluded: RecommendationResult["excluded"] = [];
  const eligible: RecommendableTable[] = [];

  for (const table of [...input.tables].sort(compareTables)) {
    const reason = exclusionReason(table);

    if (reason) {
      excluded.push({
        tableId: table.id,
        tableNumber: table.tableNumber,
        reason,
      });
    } else {
      eligible.push(table);
    }
  }

  const ranked = candidateSets(input.partySize, eligible).map((set) => {
    const capacity = set.reduce((sum, table) => sum + table.capacity, 0);
    const first = set[0]!;
    const inPreferredArea =
      !input.preferredAreaId || first.areaId === input.preferredAreaId;
    const surplus = capacity - input.partySize;
    const reasons: RecommendationReason[] = [
      set.length === 1 ? "SINGLE_TABLE" : "COMBINED_TABLES",
    ];

    if (input.preferredAreaId) {
      reasons.push(inPreferredArea ? "IN_PREFERRED_AREA" : "OUTSIDE_PREFERRED_AREA");
    }

    if (surplus === 0) {
      reasons.push("EXACT_FIT");
    }

    return {
      set,
      inPreferredArea,
      recommendation: {
        tableIds: set.map((table) => table.id),
        tableNumbers: set.map((table) => table.tableNumber),
        areaId: first.areaId,
        areaName: first.areaName,
        capacity,
        surplus,
        reasons,
      } satisfies Recommendation,
    };
  });

  ranked.sort((left, right) => {
    const a = left.recommendation;
    const b = right.recommendation;

    return (
      Number(a.tableIds.length > 1) - Number(b.tableIds.length > 1) ||
      a.tableIds.length - b.tableIds.length ||
      Number(!left.inPreferredArea) - Number(!right.inPreferredArea) ||
      a.surplus - b.surplus ||
      compareSetKeys(left.set, right.set)
    );
  });

  return {
    recommendations: ranked
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.recommendation),
    excluded,
  };
}

function compareSetKeys(
  left: readonly RecommendableTable[],
  right: readonly RecommendableTable[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const result = compareTables(left[index]!, right[index]!);

    if (result !== 0) {
      return result;
    }
  }

  return left.length - right.length;
}
