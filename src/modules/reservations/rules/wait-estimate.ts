import {
  candidateSets,
  type RecommendableTable,
} from "./table-recommendation";

/** Minutes assumed for bussing a dirty table. A guess, not a measurement. */
export const CLEANING_ALLOWANCE_MINUTES = 5;
/** Minutes assumed for a party already past its usual turn. */
export const OVERDUE_ALLOWANCE_MINUTES = 5;

export type EstimateTable = RecommendableTable & {
  /** Minutes the current party has been seated, when the table is occupied. */
  occupiedForMinutes: number | null;
  /** Minutes until an active reservation hold ends, when one is active. */
  holdEndsInMinutes: number | null;
};

export type WaitEstimate = {
  /** Null when no table or combination could ever seat the party. */
  minutes: number | null;
  basis:
    | "TABLE_AVAILABLE_NOW"
    | "EARLIEST_TABLE_TURN"
    | "NO_SUITABLE_TABLE";
  note: string;
};

/** When a table could be free, in minutes from now. Null if it won't be. */
export function minutesUntilFree(
  table: EstimateTable,
  turnMinutes: number,
): number | null {
  if (table.availability === "OUT_OF_SERVICE" || table.availability === "INACTIVE") {
    return null;
  }

  let wait = 0;

  if (table.availability === "OCCUPIED") {
    const remaining = turnMinutes - (table.occupiedForMinutes ?? 0);

    wait = Math.max(remaining, OVERDUE_ALLOWANCE_MINUTES);
  } else if (table.availability === "DIRTY") {
    wait = CLEANING_ALLOWANCE_MINUTES;
  }

  return Math.max(wait, table.holdEndsInMinutes ?? 0);
}

/**
 * A conservative estimate of how long a party waits for a table, from what's seated now,
 * the usual turn time and active reservation holds. Parties ahead take the earliest
 * suitable tables first. It is an estimate for staff to adjust, never a promise, and it
 * learns nothing from history.
 */
export function estimateWait(input: {
  partySize: number;
  /** Party sizes ahead in the queue, in order. */
  partiesAhead: readonly number[];
  tables: readonly EstimateTable[];
  turnMinutes: number;
}): WaitEstimate {
  const used = new Set<string>();
  const earliest = (partySize: number) => {
    const free = input.tables.filter(
      (table) =>
        !used.has(table.id) &&
        table.availability !== "OUT_OF_SERVICE" &&
        table.availability !== "INACTIVE",
    );
    let best: { minutes: number; tableIds: string[] } | null = null;

    for (const set of candidateSets(
      partySize,
      free.map((table) => ({ ...table, availability: "AVAILABLE" as const })),
    )) {
      const waits = set.map((member) =>
        minutesUntilFree(
          input.tables.find((table) => table.id === member.id)!,
          input.turnMinutes,
        ),
      );

      if (waits.some((wait) => wait === null)) {
        continue;
      }

      const minutes = Math.max(...(waits as number[]));

      if (best === null || minutes < best.minutes) {
        best = { minutes, tableIds: set.map((member) => member.id) };
      }
    }

    return best;
  };

  for (const ahead of input.partiesAhead) {
    const taken = earliest(ahead);

    for (const tableId of taken?.tableIds ?? []) {
      used.add(tableId);
    }
  }

  const result = earliest(input.partySize);

  if (!result) {
    return {
      minutes: null,
      basis: "NO_SUITABLE_TABLE",
      note: "No table or combination can seat this party right now.",
    };
  }

  return result.minutes === 0
    ? {
        minutes: 0,
        basis: "TABLE_AVAILABLE_NOW",
        note: "A suitable table is available now.",
      }
    : {
        minutes: result.minutes,
        basis: "EARLIEST_TABLE_TURN",
        note: "An estimate from current seatings and the usual turn time.",
      };
}
