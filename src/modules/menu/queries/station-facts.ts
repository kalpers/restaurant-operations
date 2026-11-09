import { and, asc, eq, inArray } from "drizzle-orm";

import { prepStations } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export type StationFact = {
  id: string;
  code: string;
  name: string;
  stationType: "KITCHEN" | "BAR" | "EXPO";
  active: boolean;
};

/**
 * What Kitchen may know about the stations an item was routed to: code, name and type, read
 * inside the SEND transaction and snapshotted onto the ticket. Inactive stations are
 * returned too, because a submitted route is never re-resolved.
 */
export async function readStationFacts(
  executor: DatabaseExecutor,
  locationId: string,
  stationIds: readonly string[],
): Promise<Map<string, StationFact>> {
  if (stationIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      id: prepStations.id,
      code: prepStations.code,
      name: prepStations.name,
      stationType: prepStations.stationType,
      active: prepStations.active,
    })
    .from(prepStations)
    .where(and(eq(prepStations.locationId, locationId), inArray(prepStations.id, [...new Set(stationIds)])));

  return new Map(rows.map((row) => [row.id, { ...row, stationType: row.stationType as StationFact["stationType"] }]));
}

/** Active stations of one type at a location, for Kitchen and Bar queue filters. */
export async function listWorkStations(
  executor: DatabaseExecutor,
  locationId: string,
  stationType: "KITCHEN" | "BAR",
): Promise<{ id: string; code: string; name: string }[]> {
  return executor
    .select({ id: prepStations.id, code: prepStations.code, name: prepStations.name })
    .from(prepStations)
    .where(
      and(
        eq(prepStations.locationId, locationId),
        eq(prepStations.stationType, stationType),
        eq(prepStations.active, true),
      ),
    )
    .orderBy(asc(prepStations.sortOrder), asc(prepStations.name));
}
