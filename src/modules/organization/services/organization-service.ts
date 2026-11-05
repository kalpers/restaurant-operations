import type { z } from "zod";

import { assertVersionMatched } from "@/db/helpers/versioning";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
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

export async function updateLocationSettings(
  executor: DatabaseExecutor,
  locationId: string,
  { expectedVersion, ...changes }: z.output<typeof updateLocationSettingsSchema>,
) {
  return assertVersionMatched(
    await updateLocationSettingsRow(
      executor,
      locationId,
      expectedVersion,
      changes,
    ),
    { type: "location settings record", id: locationId },
  );
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
