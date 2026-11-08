import { and, eq, inArray } from "drizzle-orm";

import { restaurantAreas, tableSessions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findEmployeeDisplayNames } from "@/modules/employees/queries/employee-display-names";
import { NotFoundError } from "@/shared/errors/app-error";

import { findOpenMemberships } from "../repositories/session-repository";
import {
  findOccupyingSessions,
  findSectionNames,
  listTablesAtLocation,
} from "../repositories/table-repository";
import { deriveTableAvailability } from "../rules/table-availability";
import type {
  AreaType,
  TableAvailability,
  TableCondition,
} from "../types";
import { assertPermission } from "./access";
import {
  findDisqualifiedServers,
  listServerCandidatesForAreas,
  type ServerCandidate,
} from "./server-eligibility-service";

export type FloorSession = {
  id: string;
  version: number;
  partySize: number;
  seatedAt: Date;
  serverEmployeeId: string | null;
  serverName: string | null;
  tables: { id: string; tableNumber: string }[];
};

/** Exactly what the floor shows. No restricted HR data or later-phase concept appears. */
export type FloorTable = {
  id: string;
  version: number;
  tableNumber: string;
  name: string | null;
  capacity: number;
  minimumCapacity: number | null;
  area: { id: string; name: string; type: AreaType };
  condition: TableCondition;
  availability: TableAvailability;
  section: string | null;
  session: FloorSession | null;
  warnings: string[];
};

/** The host's view. Availability is derived here and stored nowhere. */
export async function getFloorStatus(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<FloorTable[]> {
  assertPermission(actor, "restaurant.view");

  const now = new Date();
  const tables = await listTablesAtLocation(executor, actor.locationId);
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const occupying = await findOccupyingSessions(
    executor,
    tables.map((table) => table.id),
  );
  const sessionIds = [...new Set(occupying.values())];
  const sessionRows = sessionIds.length
    ? await executor
        .select({
          id: tableSessions.id,
          version: tableSessions.version,
          partySize: tableSessions.partySize,
          seatedAt: tableSessions.seatedAt,
          serverEmployeeId: tableSessions.assignedServerEmployeeId,
        })
        .from(tableSessions)
        .where(
          and(
            inArray(tableSessions.id, sessionIds),
            eq(tableSessions.locationId, actor.locationId),
          ),
        )
    : [];
  const serverNames = await findEmployeeDisplayNames(executor, {
    organizationId: actor.organizationId,
    employeeIds: sessionRows.flatMap((row) =>
      row.serverEmployeeId ? [row.serverEmployeeId] : [],
    ),
  });
  const memberships = await findOpenMemberships(executor, sessionIds);
  const sections = await findSectionNames(executor, actor.locationId);
  const sessions = new Map(
    sessionRows.map((row): [string, FloorSession] => [
      row.id,
      {
        id: row.id,
        version: row.version,
        partySize: row.partySize,
        seatedAt: row.seatedAt,
        serverEmployeeId: row.serverEmployeeId,
        serverName: row.serverEmployeeId
          ? (serverNames.get(row.serverEmployeeId) ?? null)
          : null,
        tables: memberships
          .filter((membership) => membership.sessionId === row.id)
          .flatMap((membership) => {
            const table = tableById.get(membership.tableId);

            return table
              ? [{ id: table.id, tableNumber: table.tableNumber }]
              : [];
          }),
      },
    ]),
  );
  const disqualified = await findDisqualifiedServers(executor, actor, {
    servers: tables.flatMap((table) => {
      const sessionId = occupying.get(table.id);
      const employeeId = sessionId && sessions.get(sessionId)?.serverEmployeeId;

      return employeeId ? [{ employeeId, areaType: table.areaType }] : [];
    }),
    instant: now,
  });

  return tables.map((table) => {
    const sessionId = occupying.get(table.id);
    const session = sessionId ? (sessions.get(sessionId) ?? null) : null;
    const seatedCapacity = session
      ? session.tables.reduce(
          (sum, { id }) => sum + (tableById.get(id)?.capacity ?? 0),
          0,
        )
      : 0;
    const warnings: string[] = [];

    if (session?.serverEmployeeId && disqualified.has(session.serverEmployeeId)) {
      warnings.push("SERVER_NEEDS_REASSIGNMENT");
    }

    if (session && session.partySize > seatedCapacity) {
      warnings.push("OVER_CAPACITY");
    }

    return {
      id: table.id,
      version: table.version,
      tableNumber: table.tableNumber,
      name: table.name,
      capacity: table.capacity,
      minimumCapacity: table.minimumCapacity,
      area: {
        id: table.restaurantAreaId,
        name: table.areaName,
        type: table.areaType,
      },
      condition: table.condition,
      availability: deriveTableAvailability({
        tableActive: table.active,
        areaActive: table.areaActive,
        condition: table.condition,
        occupied: session !== null,
      }),
      section: sections.get(table.id)?.sectionName ?? null,
      session,
      warnings,
    };
  });
}

/** Who can take work in this area, for the picker. Display name and shift status only. */
export async function listServerCandidates(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { areaId: string },
): Promise<ServerCandidate[]> {
  assertPermission(actor, "restaurant.server.assign");

  const [area] = await executor
    .select({ areaType: restaurantAreas.areaType })
    .from(restaurantAreas)
    .where(
      and(
        eq(restaurantAreas.id, input.areaId),
        eq(restaurantAreas.locationId, actor.locationId),
      ),
    );

  if (!area) {
    throw new NotFoundError("restaurant area");
  }

  return listServerCandidatesForAreas(executor, actor, {
    areaTypes: [area.areaType as AreaType],
    instant: new Date(),
  });
}
