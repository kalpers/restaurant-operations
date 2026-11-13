import { asc, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import { locations } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";

import {
  findAreaLocationIdById,
  findAreasAtLocation,
  findLocationsWithSettings,
  findOrganizationById,
  updateAreaRow,
  updateLocationRow,
  updateLocationSettingsRow,
  updateOrganizationRow,
} from "../repositories/organization-repository";
import type {
  updateAreaSchema,
  updateLocationSchema,
  updateLocationSettingsSchema,
  updateOrganizationSchema,
} from "../validators/organization-validators";

export async function getOrganization(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  const organization = await findOrganizationById(executor, organizationId);

  if (!organization) {
    throw new NotFoundError("organization");
  }

  return organization;
}

export async function updateOrganization(
  executor: DatabaseExecutor,
  organizationId: string,
  { expectedVersion, ...changes }: z.output<typeof updateOrganizationSchema>,
) {
  return assertVersionMatched(
    await updateOrganizationRow(
      executor,
      organizationId,
      expectedVersion,
      changes,
    ),
    { type: "organization", id: organizationId },
  );
}

/** The location's IANA time zone, for display (Phase 20 policy 9). UTC if not found. */
export async function getLocationTimeZone(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<string> {
  const [row] = await findLocationsWithSettings(executor, [locationId]);

  return row?.location.timezone ?? "UTC";
}

/** Lists only the given locations, so a caller passes the ones the user may view. */
export async function listLocationsWithSettings(
  executor: DatabaseExecutor,
  locationIds: readonly string[],
) {
  return locationIds.length > 0
    ? findLocationsWithSettings(executor, locationIds)
    : [];
}

export async function updateLocation(
  executor: DatabaseExecutor,
  locationId: string,
  { expectedVersion, ...changes }: z.output<typeof updateLocationSchema>,
) {
  return assertVersionMatched(
    await updateLocationRow(executor, locationId, expectedVersion, changes),
    { type: "location", id: locationId },
  );
}

const AUDITED_SETTINGS = [
  "businessDayCutoff",
  "defaultTableTurnMinutes",
  "defaultReservationDurationMinutes",
  "defaultWaitQuoteMinutes",
  "allowWalkIns",
  "allowReservations",
  "allowTakeout",
  "inventoryEnabled",
  "schedulingEnabled",
  "kitchenDisplayEnabled",
  "lotExpiryWarningDays",
] as const;

/** Phase 20 (policy 6): the change and its audit row commit together. */
export async function updateLocationSettings(
  database: Database,
  actor: Actor,
  locationId: string,
  { expectedVersion, ...changes }: z.output<typeof updateLocationSettingsSchema>,
) {
  return withTransaction(database, async (transaction) => {
    const [before] = await findLocationsWithSettings(transaction, [locationId]);
    const updated = assertVersionMatched(
      await updateLocationSettingsRow(transaction, locationId, expectedVersion, changes),
      { type: "location settings record", id: locationId },
    );
    const pick = (row: Record<string, unknown>) =>
      Object.fromEntries(
        AUDITED_SETTINGS.filter((key) => before && before.settings[key] !== updated[key]).map((key) => [key, row[key]]),
      );

    if (before && Object.keys(pick(updated)).length > 0) {
      await recordAudit(transaction, actor, {
        action: "organization.location-settings-changed",
        entityId: locationId,
        before: pick(before.settings),
        after: pick(updated),
      });
    }

    return updated;
  });
}

export function listAreas(executor: DatabaseExecutor, locationId: string) {
  return findAreasAtLocation(executor, locationId);
}

/** Lets a Route Handler authorize against the area's own location. */
export async function findAreaLocationId(
  executor: DatabaseExecutor,
  areaId: string,
): Promise<string> {
  const locationId = await findAreaLocationIdById(executor, areaId);

  if (!locationId) {
    throw new NotFoundError("area");
  }

  return locationId;
}

export async function updateArea(
  executor: DatabaseExecutor,
  areaId: string,
  changes: z.output<typeof updateAreaSchema>,
) {
  const area = await updateAreaRow(executor, areaId, changes);

  if (!area) {
    throw new NotFoundError("area");
  }

  return area;
}

/** Every active location, for system jobs such as the Phase 20 periodic notification check. */
export async function listActiveLocations(executor: DatabaseExecutor) {
  return executor
    .select({ id: locations.id, organizationId: locations.organizationId, timeZone: locations.timezone })
    .from(locations)
    .where(eq(locations.active, true))
    .orderBy(asc(locations.locationCode));
}
