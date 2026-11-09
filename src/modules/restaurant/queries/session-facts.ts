import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { restaurantAreas, restaurantTables, tableSessions, tableSessionTables } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";

import type { AreaType } from "../types";

/**
 * What the Orders domain may know about a Table Session it attaches an order to. The row is
 * locked FOR SHARE, so a concurrent completion or cancellation (which locks it FOR UPDATE)
 * waits for the order to commit, and then sees it.
 */
export type SessionForOrder = {
  id: string;
  status: string;
  guestPartyId: string | null;
  assignedServerEmployeeId: string | null;
  /** The area types of the tables the session holds now. One area per session. */
  areaTypes: AreaType[];
};

export async function lockSessionForOrder(
  transaction: DatabaseTransaction,
  locationId: string,
  sessionId: string,
): Promise<SessionForOrder | null> {
  const [session] = await transaction
    .select({
      id: tableSessions.id,
      status: tableSessions.status,
      guestPartyId: tableSessions.guestPartyId,
      assignedServerEmployeeId: tableSessions.assignedServerEmployeeId,
    })
    .from(tableSessions)
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.locationId, locationId)))
    .for("share");

  if (!session) {
    return null;
  }

  const areas = await transaction
    .selectDistinct({ areaType: restaurantAreas.areaType })
    .from(tableSessionTables)
    .innerJoin(restaurantTables, eq(restaurantTables.id, tableSessionTables.restaurantTableId))
    .innerJoin(restaurantAreas, eq(restaurantAreas.id, restaurantTables.restaurantAreaId))
    .where(and(eq(tableSessionTables.tableSessionId, sessionId), isNull(tableSessionTables.leftAt)));

  return { ...session, areaTypes: areas.map((row) => row.areaType as AreaType) };
}

/** Table numbers for display: a session's current tables, or the last it held once ended. */
export async function tableNumbersForSessions(executor: DatabaseExecutor, sessionIds: readonly string[]) {
  const result = new Map<string, string[]>();

  if (sessionIds.length === 0) {
    return result;
  }

  const rows = await executor
    .selectDistinct({
      sessionId: tableSessionTables.tableSessionId,
      tableNumber: restaurantTables.tableNumber,
      open: sql<boolean>`${tableSessionTables.leftAt} IS NULL`,
    })
    .from(tableSessionTables)
    .innerJoin(restaurantTables, eq(restaurantTables.id, tableSessionTables.restaurantTableId))
    .where(inArray(tableSessionTables.tableSessionId, [...sessionIds]))
    .orderBy(asc(restaurantTables.tableNumber));

  for (const sessionId of sessionIds) {
    const own = rows.filter((row) => row.sessionId === sessionId);
    const open = own.filter((row) => row.open);

    result.set(sessionId, [...new Set((open.length > 0 ? open : own).map((row) => row.tableNumber))]);
  }

  return result;
}
