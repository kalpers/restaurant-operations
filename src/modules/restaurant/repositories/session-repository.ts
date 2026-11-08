import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  serverSectionAssignments,
  serverSections,
  serverSectionTables,
  tableSessionOverrides,
  tableSessions,
  tableSessionTables,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

/** Locks the session first, so every session operation takes locks in the same order. */
export async function lockSession(
  transaction: DatabaseTransaction,
  sessionId: string,
  locationId: string,
) {
  const [row] = await transaction
    .select()
    .from(tableSessions)
    .where(
      and(eq(tableSessions.id, sessionId), eq(tableSessions.locationId, locationId)),
    )
    .for("update");

  return row ?? null;
}

export async function findOpenMemberships(
  executor: DatabaseExecutor,
  sessionIds: readonly string[],
) {
  if (sessionIds.length === 0) {
    return [];
  }

  return executor
    .select({
      sessionId: tableSessionTables.tableSessionId,
      tableId: tableSessionTables.restaurantTableId,
    })
    .from(tableSessionTables)
    .where(
      and(
        inArray(tableSessionTables.tableSessionId, [...sessionIds]),
        isNull(tableSessionTables.leftAt),
      ),
    );
}

export async function openMemberships(
  transaction: DatabaseTransaction,
  input: {
    sessionId: string;
    locationId: string;
    tableIds: readonly string[];
    joinedAt: Date;
  },
): Promise<void> {
  if (input.tableIds.length === 0) {
    return;
  }

  await transaction.insert(tableSessionTables).values(
    input.tableIds.map((restaurantTableId) => ({
      tableSessionId: input.sessionId,
      locationId: input.locationId,
      restaurantTableId,
      joinedAt: input.joinedAt,
    })),
  );
}

/** Ends memberships and keeps the rows, which are the session's table history. */
export async function endMemberships(
  transaction: DatabaseTransaction,
  input: { sessionId: string; tableIds: readonly string[]; leftAt: Date },
): Promise<void> {
  if (input.tableIds.length === 0) {
    return;
  }

  await transaction
    .update(tableSessionTables)
    .set({ leftAt: input.leftAt })
    .where(
      and(
        eq(tableSessionTables.tableSessionId, input.sessionId),
        inArray(tableSessionTables.restaurantTableId, [...input.tableIds]),
        isNull(tableSessionTables.leftAt),
      ),
    );
}

export async function recordCapacityOverride(
  transaction: DatabaseTransaction,
  input: {
    sessionId: string;
    reason: string;
    userId: string;
    partySize: number;
    seatedCapacity: number;
    occurredAt: Date;
  },
): Promise<void> {
  await transaction.insert(tableSessionOverrides).values({
    tableSessionId: input.sessionId,
    overrideType: "CAPACITY",
    reason: input.reason,
    overriddenByUserId: input.userId,
    partySize: input.partySize,
    seatedCapacity: input.seatedCapacity,
    occurredAt: input.occurredAt,
  });
}

export async function recordScheduleOverride(
  transaction: DatabaseTransaction,
  input: {
    sessionId: string;
    reason: string;
    userId: string;
    serverEmployeeId: string;
    occurredAt: Date;
  },
): Promise<void> {
  await transaction.insert(tableSessionOverrides).values({
    tableSessionId: input.sessionId,
    overrideType: "SERVER_SCHEDULE",
    reason: input.reason,
    overriddenByUserId: input.userId,
    serverEmployeeId: input.serverEmployeeId,
    occurredAt: input.occurredAt,
  });
}

/** Table ID to the server working its section on this business date, where there is one. */
export async function findSectionServers(
  executor: DatabaseExecutor,
  input: { tableIds: readonly string[]; businessDate: string },
): Promise<Map<string, string>> {
  if (input.tableIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      tableId: serverSectionTables.restaurantTableId,
      employeeId: serverSectionAssignments.employeeId,
    })
    .from(serverSectionTables)
    .innerJoin(
      serverSections,
      eq(serverSections.id, serverSectionTables.serverSectionId),
    )
    .innerJoin(
      serverSectionAssignments,
      eq(serverSectionAssignments.serverSectionId, serverSections.id),
    )
    .where(
      and(
        inArray(serverSectionTables.restaurantTableId, [...input.tableIds]),
        eq(serverSectionTables.active, true),
        eq(serverSections.active, true),
        eq(serverSectionAssignments.businessDate, input.businessDate),
        isNull(serverSectionAssignments.effectiveTo),
      ),
    );

  return new Map(rows.map((row) => [row.tableId, row.employeeId]));
}
