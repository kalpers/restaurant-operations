import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation, readConstraintName } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import { menuItemPrepRouting, prepStations } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import type { StationType } from "../types";
import { assertAnyPermission, assertPermission, requireMenuItem } from "./access";

// Preparation routing is configuration only. Phase 10 Kitchen snapshots a send's routing
// onto its tickets, so changing routing or a station never moves submitted work. A station
// with unfinished work can't be deactivated until that work is resolved; a database trigger
// (`prep_stations_active_work`) enforces it on every path, and this service reports it.

type StationInput = {
  name: string;
  stationType: StationType;
  sortOrder: number;
};

export async function listStations(executor: DatabaseExecutor, actor: Actor) {
  assertAnyPermission(actor, ["menu.view", "prep-stations.manage"]);

  return executor
    .select()
    .from(prepStations)
    .where(eq(prepStations.locationId, actor.locationId))
    .orderBy(asc(prepStations.sortOrder), asc(prepStations.name));
}

export async function createStation(
  database: Database,
  actor: Actor,
  input: StationInput & { code: string },
) {
  assertPermission(actor, "prep-stations.manage");

  try {
    const [row] = await database
      .insert(prepStations)
      .values({ ...input, locationId: actor.locationId })
      .returning();

    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_TAKEN", "Another station here already uses that code.");
    }

    throw error;
  }
}

export async function updateStation(
  database: Database,
  actor: Actor,
  stationId: string,
  input: StationInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "prep-stations.manage");

  const { expectedVersion, ...values } = input;
  const rows = await database
    .update(prepStations)
    .set({ ...values, version: nextVersion(prepStations.version), updatedAt: new Date() })
    .where(
      and(
        eq(prepStations.id, stationId),
        eq(prepStations.locationId, actor.locationId),
        eq(prepStations.version, expectedVersion),
      ),
    )
    .returning()
    .catch((error: unknown) => {
      if (readConstraintName(error) === "prep_stations_active_work") {
        throw new BusinessRuleError(
          "STATION_HAS_ACTIVE_WORK",
          "This station still has items to prepare. Finish or void them before deactivating it.",
        );
      }

      throw error;
    });

  if (rows[0]) {
    return rows[0];
  }

  const [existing] = await database
    .select({ id: prepStations.id })
    .from(prepStations)
    .where(and(eq(prepStations.id, stationId), eq(prepStations.locationId, actor.locationId)));

  if (!existing) {
    throw new NotFoundError("prep station");
  }

  throw new ConcurrencyError("prep station", stationId);
}

export async function listItemRouting(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
) {
  assertAnyPermission(actor, ["menu.view", "prep-stations.manage"]);
  await requireMenuItem(executor, actor, menuItemId);

  return executor
    .select()
    .from(menuItemPrepRouting)
    .where(
      and(
        eq(menuItemPrepRouting.menuItemId, menuItemId),
        eq(menuItemPrepRouting.locationId, actor.locationId),
      ),
    )
    .orderBy(asc(menuItemPrepRouting.sortOrder));
}

/**
 * Sets the stations that prepare an item at the actor's location, replacing the previous
 * set in one transaction. Stations dropped from the list are deactivated, not deleted,
 * so a station that is chosen again keeps its row.
 */
export async function setItemRouting(
  database: Database,
  actor: Actor,
  menuItemId: string,
  input: { prepStationIds: readonly string[] },
) {
  assertPermission(actor, "prep-stations.manage");

  const wanted = [...new Set(input.prepStationIds)];

  return withTransaction(database, async (transaction) => {
    await requireMenuItem(transaction, actor, menuItemId);

    if (wanted.length > 0) {
      const found = await transaction
        .select({ id: prepStations.id })
        .from(prepStations)
        .where(
          and(
            inArray(prepStations.id, wanted),
            eq(prepStations.locationId, actor.locationId),
            eq(prepStations.active, true),
          ),
        );

      if (found.length !== wanted.length) {
        throw new NotFoundError("prep station");
      }
    }

    const existing = await transaction
      .select()
      .from(menuItemPrepRouting)
      .where(
        and(
          eq(menuItemPrepRouting.menuItemId, menuItemId),
          eq(menuItemPrepRouting.locationId, actor.locationId),
        ),
      );

    for (const row of existing) {
      if (row.active && !wanted.includes(row.prepStationId)) {
        await transaction
          .update(menuItemPrepRouting)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(menuItemPrepRouting.id, row.id));
      }
    }

    for (const [index, stationId] of wanted.entries()) {
      await transaction
        .insert(menuItemPrepRouting)
        .values({
          organizationId: actor.organizationId,
          menuItemId,
          locationId: actor.locationId,
          prepStationId: stationId,
          sortOrder: index,
        })
        .onConflictDoUpdate({
          target: [
            menuItemPrepRouting.menuItemId,
            menuItemPrepRouting.locationId,
            menuItemPrepRouting.prepStationId,
          ],
          set: { active: true, sortOrder: index, updatedAt: new Date() },
        });
    }

    return transaction
      .select()
      .from(menuItemPrepRouting)
      .where(
        and(
          eq(menuItemPrepRouting.menuItemId, menuItemId),
          eq(menuItemPrepRouting.locationId, actor.locationId),
          eq(menuItemPrepRouting.active, true),
        ),
      )
      .orderBy(asc(menuItemPrepRouting.sortOrder));
  });
}
