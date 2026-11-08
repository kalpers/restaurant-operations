import { eq } from "drizzle-orm";

import { locations, locationSettings } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { localDateOf } from "@/shared/time/zoned-time";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Every service calls this itself, so a request is refused however it's reached. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}

export type LocationClock = {
  timeZone: string;
  /** The local calendar date, which is what HR effective dates mean. */
  localDate: string;
  /** The restaurant operating day, from the one BusinessDateService. */
  businessDate: string;
};

/** What "today" means at a location, for this instant. */
export async function readLocationClock(
  executor: DatabaseExecutor,
  locationId: string,
  instant: Date,
): Promise<LocationClock> {
  const [row] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return {
    timeZone: row.timeZone,
    localDate: localDateOf(instant, row.timeZone),
    businessDate: businessDateOf(instant, row),
  };
}
