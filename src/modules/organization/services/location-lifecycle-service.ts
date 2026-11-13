import { and, count, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { locations, locationSettings, restaurantAreas } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { AuthorizationError, BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

// Phase 23 (policies 1 and 3): the Organization module's part of opening and closing a
// location. The open-location and deactivate-location workflows call these inside their
// transaction, together with the other modules' own setup and "anything open?" functions.

/** The three standard areas every location starts with (README section 8). */
export const DEFAULT_AREAS = [
  { code: "DINING_ROOM", name: "Dining Room", areaType: "DINING", displayOrder: 1 },
  { code: "BAR", name: "Bar", areaType: "BAR", displayOrder: 2 },
  { code: "TAKEOUT", name: "Takeout", areaType: "TAKEOUT", displayOrder: 3 },
] as const;

export type NewLocationInput = {
  organizationId: string;
  name: string;
  locationCode: string;
  timezone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  email: string | null;
};

/**
 * Inserts the location, its settings and the standard areas. With `settingsFrom`, the
 * operational settings are copied from that location (D2 `SETTINGS`), otherwise the
 * defaults apply. `copyTaxSwitch` also copies whether tax is on (D2 `TAX_RATES`).
 */
export async function insertLocationWithDefaults(
  transaction: DatabaseTransaction,
  input: NewLocationInput,
  options: { settingsFrom: string | null; copyTaxSwitch: boolean },
): Promise<string> {
  const [taken] = await transaction
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.organizationId, input.organizationId),
        eq(locations.locationCode, input.locationCode),
      ),
    );

  if (taken) {
    throw new ConflictError("LOCATION_CODE_TAKEN", "Another location already uses that code.");
  }

  const [location] = await transaction
    .insert(locations)
    .values(input)
    .returning({ id: locations.id });
  const locationId = location!.id;
  const source = options.settingsFrom
    ? (
        await transaction
          .select()
          .from(locationSettings)
          .where(eq(locationSettings.locationId, options.settingsFrom))
      )[0]
    : undefined;

  if (options.settingsFrom && !source) {
    throw new NotFoundError("location");
  }

  await transaction.insert(locationSettings).values(
    source
      ? {
          locationId,
          businessDayCutoff: source.businessDayCutoff,
          defaultTableTurnMinutes: source.defaultTableTurnMinutes,
          defaultReservationDurationMinutes: source.defaultReservationDurationMinutes,
          defaultWaitQuoteMinutes: source.defaultWaitQuoteMinutes,
          reservationPreHoldMinutes: source.reservationPreHoldMinutes,
          reservationPostGraceMinutes: source.reservationPostGraceMinutes,
          allowWalkIns: source.allowWalkIns,
          allowReservations: source.allowReservations,
          allowTakeout: source.allowTakeout,
          inventoryEnabled: source.inventoryEnabled,
          allowNegativeInventory: source.allowNegativeInventory,
          schedulingEnabled: source.schedulingEnabled,
          kitchenDisplayEnabled: source.kitchenDisplayEnabled,
          cashDrawerRequired: source.cashDrawerRequired,
          auto86FromStock: source.auto86FromStock,
          runningLowPortions: source.runningLowPortions,
          lotExpiryWarningDays: source.lotExpiryWarningDays,
          ...(options.copyTaxSwitch ? { taxEnabled: source.taxEnabled } : {}),
        }
      : { locationId },
  );
  await transaction
    .insert(restaurantAreas)
    .values(DEFAULT_AREAS.map((area) => ({ ...area, locationId })));

  return locationId;
}

/** Locks a location of the organization for a lifecycle change and checks its version. */
export async function lockLocation(
  transaction: DatabaseTransaction,
  input: { organizationId: string; locationId: string; expectedVersion: number },
) {
  const [row] = await transaction
    .select({
      id: locations.id,
      active: locations.active,
      version: locations.version,
      locationCode: locations.locationCode,
    })
    .from(locations)
    .where(
      and(
        eq(locations.id, input.locationId),
        eq(locations.organizationId, input.organizationId),
      ),
    )
    .for("update");

  if (!row) {
    throw new NotFoundError("location");
  }

  if (row.version !== input.expectedVersion) {
    throw new ConcurrencyError("location", input.locationId);
  }

  return row;
}

/** Sets `active` on a locked location and bumps its version. */
export async function setLocationActive(
  transaction: DatabaseTransaction,
  locationId: string,
  active: boolean,
): Promise<number> {
  const [row] = await transaction
    .update(locations)
    .set({ active, version: sql`${locations.version} + 1`, updatedAt: new Date() })
    .where(eq(locations.id, locationId))
    .returning({ version: locations.version });

  return row!.version;
}

/** Refuses closing the organization's last active location. */
export async function assertAnotherActiveLocation(
  transaction: DatabaseTransaction,
  organizationId: string,
): Promise<void> {
  const [row] = await transaction
    .select({ total: count() })
    .from(locations)
    .where(and(eq(locations.organizationId, organizationId), eq(locations.active, true)));

  if ((row?.total ?? 0) <= 1) {
    throw new BusinessRuleError(
      "LAST_ACTIVE_LOCATION",
      "This is the only active location. Open another before closing it.",
    );
  }
}

/**
 * Phase 23 (policy 3): reopens a closed location as it was. Grants there count again at
 * once; online booking stays off until a manager turns it on.
 */
export async function reactivateLocation(
  database: Database,
  actor: Actor,
  input: { locationId: string; expectedVersion: number },
): Promise<{ version: number }> {
  if (!actor.permissions.has("locations.lifecycle")) {
    throw new AuthorizationError();
  }

  return withTransaction(database, async (transaction) => {
    const location = await lockLocation(transaction, {
      organizationId: actor.organizationId,
      locationId: input.locationId,
      expectedVersion: input.expectedVersion,
    });

    if (location.active) {
      throw new BusinessRuleError("LOCATION_ACTIVE", "This location is already open.");
    }

    const version = await setLocationActive(transaction, input.locationId, true);

    await recordAudit(transaction, actor, {
      action: "locations.reactivated",
      entityId: input.locationId,
      after: { locationCode: location.locationCode, active: true },
    });

    return { version };
  });
}

/** Every location of the organization, open or closed, for the lifecycle screen. */
export function listOrganizationLocations(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .select({
      id: locations.id,
      name: locations.name,
      locationCode: locations.locationCode,
      timezone: locations.timezone,
      active: locations.active,
      version: locations.version,
    })
    .from(locations)
    .where(eq(locations.organizationId, organizationId))
    .orderBy(locations.locationCode);
}
