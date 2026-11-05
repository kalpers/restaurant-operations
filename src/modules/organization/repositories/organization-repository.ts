import { and, asc, eq, inArray } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  locations,
  locationSettings,
  organizations,
  restaurantAreas,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export async function findOrganizationById(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  const [organization] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  return organization;
}

/** Returns no rows when the version is stale. */
export function updateOrganizationRow(
  executor: DatabaseExecutor,
  organizationId: string,
  expectedVersion: number,
  changes: Partial<typeof organizations.$inferInsert>,
) {
  return executor
    .update(organizations)
    .set({ ...changes, version: nextVersion(organizations.version) })
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.version, expectedVersion),
      ),
    )
    .returning();
}

export function findLocationsByCode(
  executor: DatabaseExecutor,
  locationCode: string,
) {
  return executor
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, locationCode));
}

export function findLocationsWithSettings(
  executor: DatabaseExecutor,
  locationIds: readonly string[],
) {
  return executor
    .select({ location: locations, settings: locationSettings })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(inArray(locations.id, [...locationIds]))
    .orderBy(asc(locations.locationCode));
}

/** Returns no rows when the version is stale. */
export function updateLocationRow(
  executor: DatabaseExecutor,
  locationId: string,
  expectedVersion: number,
  changes: Partial<typeof locations.$inferInsert>,
) {
  return executor
    .update(locations)
    .set({ ...changes, version: nextVersion(locations.version) })
    .where(
      and(eq(locations.id, locationId), eq(locations.version, expectedVersion)),
    )
    .returning();
}

/** Returns no rows when the version is stale. */
export function updateLocationSettingsRow(
  executor: DatabaseExecutor,
  locationId: string,
  expectedVersion: number,
  changes: Partial<typeof locationSettings.$inferInsert>,
) {
  return executor
    .update(locationSettings)
    .set({ ...changes, version: nextVersion(locationSettings.version) })
    .where(
      and(
        eq(locationSettings.locationId, locationId),
        eq(locationSettings.version, expectedVersion),
      ),
    )
    .returning();
}

export function findAreasAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
) {
  return executor
    .select()
    .from(restaurantAreas)
    .where(eq(restaurantAreas.locationId, locationId))
    .orderBy(asc(restaurantAreas.displayOrder), asc(restaurantAreas.code));
}

export async function findAreaLocationIdById(
  executor: DatabaseExecutor,
  areaId: string,
) {
  const [area] = await executor
    .select({ locationId: restaurantAreas.locationId })
    .from(restaurantAreas)
    .where(eq(restaurantAreas.id, areaId));

  return area?.locationId;
}

export async function updateAreaRow(
  executor: DatabaseExecutor,
  areaId: string,
  changes: Partial<typeof restaurantAreas.$inferInsert>,
) {
  const [area] = await executor
    .update(restaurantAreas)
    .set(changes)
    .where(eq(restaurantAreas.id, areaId))
    .returning();

  return area;
}
