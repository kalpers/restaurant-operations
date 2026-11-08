import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  AuthorizationError,
  BusinessRuleError,
  NotFoundError,
} from "@/shared/errors/app-error";

import {
  findOccupyingSessions,
  lockTables,
  type TableRow,
} from "../repositories/table-repository";
import { combinedCapacity, evaluateCapacity } from "../rules/capacity";
import {
  assertTableSeatable,
  deriveTableAvailability,
} from "../rules/table-availability";
import { actorHolds } from "./access";

/** Locks every named table, or fails if one isn't at this location. */
export async function lockTablesAtLocation(
  transaction: DatabaseTransaction,
  locationId: string,
  tableIds: readonly string[],
): Promise<TableRow[]> {
  const tables = await lockTables(transaction, tableIds, locationId);

  if (tables.length !== new Set(tableIds).size) {
    throw new NotFoundError("table");
  }

  return tables;
}

/**
 * Availability, read after the locks are held. Pass only tables a session is about to
 * take: one it already occupies would read as occupied.
 */
export async function assertTablesSeatable(
  transaction: DatabaseTransaction,
  tables: readonly TableRow[],
): Promise<void> {
  const occupying = await findOccupyingSessions(
    transaction,
    tables.map((table) => table.id),
  );

  for (const table of tables) {
    assertTableSeatable(
      deriveTableAvailability({
        tableActive: table.active,
        areaActive: table.areaActive,
        condition: table.condition,
        occupied: occupying.has(table.id),
      }),
      table.tableNumber,
    );
  }
}

/** A session's tables share one area, so server qualification has one answer. */
export function assertOneArea(tables: readonly TableRow[]): TableRow["areaType"] {
  const [first] = tables;

  if (
    !first ||
    tables.some((table) => table.restaurantAreaId !== first.restaurantAreaId)
  ) {
    throw new BusinessRuleError(
      "TABLES_IN_DIFFERENT_AREAS",
      "Tables in one session must be in the same area.",
    );
  }

  return first.areaType;
}

/** The stated reason when capacity is overridden; null when none was needed. */
export function checkCapacity(
  actor: Actor,
  input: {
    partySize: number;
    tables: readonly { capacity: number }[];
    overrideReason: string | null | undefined;
  },
): { overrideReason: string | null; capacity: number } {
  const capacity = combinedCapacity(input.tables);
  const decision = evaluateCapacity({
    partySize: input.partySize,
    capacity,
    canOverride: actorHolds(actor, "restaurant.capacity.override"),
    overrideReason: input.overrideReason,
  });

  switch (decision.outcome) {
    case "WITHIN_CAPACITY":
      return { overrideReason: null, capacity };
    case "OVERRIDDEN":
      return { overrideReason: decision.reason, capacity };
    case "REASON_REQUIRED":
      throw new BusinessRuleError(
        "CAPACITY_OVERRIDE_REASON_REQUIRED",
        `This party of ${input.partySize} is over the capacity of ${capacity}. Give a reason to override.`,
      );
    case "DENIED":
      if (input.overrideReason?.trim()) {
        throw new AuthorizationError();
      }

      throw new BusinessRuleError(
        "PARTY_EXCEEDS_CAPACITY",
        `This party of ${input.partySize} is over the capacity of ${capacity}. A manager can override this.`,
      );
  }
}
