import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  restaurantAreas,
  restaurantTables,
  serverSections,
  serverSectionTables,
  tableConditionHistory,
  tableSessionTables,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

import type { AreaType, TableCondition } from "../types";

const TABLE_COLUMNS = {
  id: restaurantTables.id,
  locationId: restaurantTables.locationId,
  restaurantAreaId: restaurantTables.restaurantAreaId,
  tableNumber: restaurantTables.tableNumber,
  name: restaurantTables.name,
  capacity: restaurantTables.capacity,
  minimumCapacity: restaurantTables.minimumCapacity,
  condition: restaurantTables.condition,
  sortOrder: restaurantTables.sortOrder,
  active: restaurantTables.active,
  version: restaurantTables.version,
  areaName: restaurantAreas.name,
  areaType: restaurantAreas.areaType,
  areaActive: restaurantAreas.active,
};

export type TableRow = {
  id: string;
  locationId: string;
  restaurantAreaId: string;
  tableNumber: string;
  name: string | null;
  capacity: number;
  minimumCapacity: number | null;
  condition: TableCondition;
  sortOrder: number;
  active: boolean;
  version: number;
  areaName: string;
  areaType: AreaType;
  areaActive: boolean;
};

export async function listTablesAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<TableRow[]> {
  const rows = await executor
    .select(TABLE_COLUMNS)
    .from(restaurantTables)
    .innerJoin(
      restaurantAreas,
      eq(restaurantAreas.id, restaurantTables.restaurantAreaId),
    )
    .where(eq(restaurantTables.locationId, locationId))
    .orderBy(
      asc(restaurantAreas.displayOrder),
      asc(restaurantTables.sortOrder),
      asc(restaurantTables.tableNumber),
    );

  return rows as TableRow[];
}

/**
 * Locks these tables until the transaction ends, sorted so two writers can't deadlock.
 * Everything that depends on availability must read after this. Tables at another
 * location aren't returned.
 */
export async function lockTables(
  transaction: DatabaseTransaction,
  tableIds: readonly string[],
  locationId: string,
): Promise<TableRow[]> {
  const unique = [...new Set(tableIds)];

  if (unique.length === 0) {
    return [];
  }

  const rows = await transaction
    .select(TABLE_COLUMNS)
    .from(restaurantTables)
    .innerJoin(
      restaurantAreas,
      eq(restaurantAreas.id, restaurantTables.restaurantAreaId),
    )
    .where(
      and(
        inArray(restaurantTables.id, unique),
        eq(restaurantTables.locationId, locationId),
      ),
    )
    .orderBy(asc(restaurantTables.id))
    .for("update", { of: restaurantTables });

  return rows as TableRow[];
}

/** Table ID to the session occupying it. Occupancy is only ever derived from this. */
export async function findOccupyingSessions(
  executor: DatabaseExecutor,
  tableIds: readonly string[],
): Promise<Map<string, string>> {
  if (tableIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      tableId: tableSessionTables.restaurantTableId,
      sessionId: tableSessionTables.tableSessionId,
    })
    .from(tableSessionTables)
    .where(
      and(
        inArray(tableSessionTables.restaurantTableId, [...tableIds]),
        isNull(tableSessionTables.leftAt),
      ),
    );

  return new Map(rows.map((row) => [row.tableId, row.sessionId]));
}

/** Sets the condition and appends its history, on the caller's transaction. */
export async function writeTableCondition(
  transaction: DatabaseTransaction,
  input: {
    tableId: string;
    condition: TableCondition;
    reason: string | null;
    userId: string;
    occurredAt: Date;
  },
): Promise<{ id: string; version: number }> {
  const [row] = await transaction
    .update(restaurantTables)
    .set({
      condition: input.condition,
      version: nextVersion(restaurantTables.version),
    })
    .where(eq(restaurantTables.id, input.tableId))
    .returning({ id: restaurantTables.id, version: restaurantTables.version });

  await transaction.insert(tableConditionHistory).values({
    restaurantTableId: input.tableId,
    condition: input.condition,
    reason: input.reason,
    changedByUserId: input.userId,
    occurredAt: input.occurredAt,
  });

  return row!;
}

/** Table ID to the name of its active section, for the floor. */
export async function findSectionNames(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<Map<string, { sectionId: string; sectionName: string }>> {
  const rows = await executor
    .select({
      tableId: serverSectionTables.restaurantTableId,
      sectionId: serverSections.id,
      sectionName: serverSections.name,
    })
    .from(serverSectionTables)
    .innerJoin(
      serverSections,
      eq(serverSections.id, serverSectionTables.serverSectionId),
    )
    .where(
      and(
        eq(serverSectionTables.locationId, locationId),
        eq(serverSectionTables.active, true),
        eq(serverSections.active, true),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.tableId,
      { sectionId: row.sectionId, sectionName: row.sectionName },
    ]),
  );
}
