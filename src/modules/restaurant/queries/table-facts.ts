import { inArray } from "drizzle-orm";

import { tableSessions } from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { BusinessRuleError } from "@/shared/errors/app-error";

import {
  findOccupyingSessions,
  listTablesAtLocation,
} from "../repositories/table-repository";
import { combinedCapacity } from "../rules/capacity";
import { deriveTableAvailability } from "../rules/table-availability";
import type { AreaType, TableAvailability } from "../types";
import { assertOneArea, lockTablesAtLocation } from "../services/seating-checks";

/**
 * What the Reservations domain may know about a physical table: no session detail beyond
 * when it was seated, and nothing about people.
 */
export type TableFact = {
  id: string;
  tableNumber: string;
  capacity: number;
  areaId: string;
  areaName: string;
  areaType: AreaType;
  /** Table and area both in use. */
  usable: boolean;
  availability: TableAvailability;
  /** When the current session was seated, if the table is occupied. */
  occupiedSince: Date | null;
};

export async function listTableFacts(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<TableFact[]> {
  const tables = await listTablesAtLocation(executor, locationId);
  const occupying = await findOccupyingSessions(
    executor,
    tables.map((table) => table.id),
  );
  const sessionIds = [...new Set(occupying.values())];
  const seatedAt = new Map(
    sessionIds.length
      ? (
          await executor
            .select({ id: tableSessions.id, seatedAt: tableSessions.seatedAt })
            .from(tableSessions)
            .where(inArray(tableSessions.id, sessionIds))
        ).map((row): [string, Date] => [row.id, row.seatedAt])
      : [],
  );

  return tables.map((table) => {
    const sessionId = occupying.get(table.id);

    return {
      id: table.id,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
      areaId: table.restaurantAreaId,
      areaName: table.areaName,
      areaType: table.areaType,
      usable: table.active && table.areaActive,
      availability: deriveTableAvailability({
        tableActive: table.active,
        areaActive: table.areaActive,
        condition: table.condition,
        occupied: sessionId !== undefined,
      }),
      occupiedSince: sessionId ? (seatedAt.get(sessionId) ?? null) : null,
    };
  });
}

/**
 * Locks tables for planning, which serialises planners with seaters, and returns them if
 * they are all at this location, in use, and in one area. Planning needs no particular
 * condition: a table that is dirty now can be planned for later.
 */
export async function lockTablesForPlanning(
  transaction: DatabaseTransaction,
  locationId: string,
  tableIds: readonly string[],
): Promise<{ id: string; tableNumber: string; capacity: number }[]> {
  const tables = await lockTablesAtLocation(transaction, locationId, tableIds);

  for (const table of tables) {
    if (!table.active || !table.areaActive) {
      throw new BusinessRuleError(
        "TABLE_INACTIVE",
        `Table ${table.tableNumber} isn't in use.`,
      );
    }
  }

  if (tables.length > 0) {
    assertOneArea(tables);
  }

  return tables.map((table) => ({
    id: table.id,
    tableNumber: table.tableNumber,
    capacity: table.capacity,
  }));
}

export { combinedCapacity };
