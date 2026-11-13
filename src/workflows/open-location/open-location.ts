import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { locations } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import { copyOwnRolesToLocation } from "@/modules/auth/services/user-service";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { copyStockedItems } from "@/modules/inventory/services/location-setup";
import {
  copyLocationPrices,
  copyMenusOffered,
  copyPrepStationsAndRouting,
  copyTaxRates,
} from "@/modules/menu/services/location-setup";
import {
  insertLocationWithDefaults,
  type NewLocationInput,
} from "@/modules/organization/services/location-lifecycle-service";
import { createLocationOnlineBooking } from "@/modules/reservations/services/location-setup";
import { createLocationSchedulingRules } from "@/modules/scheduling/services/location-setup";
import { copyTipPoolRules } from "@/modules/settlements/services/location-setup";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

// Phase 23 (policies 1–2, D1–D2): opening a location. One transaction creates the location,
// its settings and areas, every module's per-location defaults, the chosen copies from an
// existing location, and the creator's own roles there. Each module writes its own tables.
// Never copied: tables, sections, staff and grants (other than the creator's), stock,
// drawers, schedules, reservations, orders and 86 entries.

export const COPY_GROUPS = [
  "SETTINGS",
  "STATIONS_AND_ROUTING",
  "MENUS",
  "PRICES",
  "TAX_RATES",
  "STOCKED_ITEMS",
  "SCHEDULING_RULES",
  "TIP_POOL_RULES",
  "BOOKING_HOURS",
] as const;

export type CopyGroup = (typeof COPY_GROUPS)[number];

export type OpenLocationInput = Omit<NewLocationInput, "organizationId"> & {
  copyFrom: { locationId: string; groups: readonly CopyGroup[] } | null;
};

export async function openLocation(
  database: Database,
  actor: Actor,
  input: OpenLocationInput,
  now = new Date(),
): Promise<{ locationId: string; rolesCopied: number }> {
  if (!actor.permissions.has("locations.lifecycle")) {
    throw new AuthorizationError();
  }

  const source = input.copyFrom;

  if (
    source &&
    !(await userHasPermission(database, {
      userId: actor.userId,
      permission: "locations.view",
      locationId: source.locationId,
    }))
  ) {
    throw new AuthorizationError();
  }

  const groups = new Set(source?.groups ?? []);
  const from = source?.locationId ?? null;

  return withTransaction(database, async (transaction) => {
    if (from) {
      const [row] = await transaction
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, from), eq(locations.organizationId, actor.organizationId)));

      if (!row) {
        throw new NotFoundError("location");
      }
    }

    const locationId = await insertLocationWithDefaults(
      transaction,
      {
        organizationId: actor.organizationId,
        name: input.name,
        locationCode: input.locationCode,
        timezone: input.timezone,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        phone: input.phone,
        email: input.email,
      },
      {
        settingsFrom: from && groups.has("SETTINGS") ? from : null,
        copyTaxSwitch: groups.has("SETTINGS") && groups.has("TAX_RATES"),
      },
    );
    const copy = { organizationId: actor.organizationId, fromLocationId: from ?? "", toLocationId: locationId, userId: actor.userId, now };

    await createLocationSchedulingRules(transaction, {
      locationId,
      copyFromLocationId: from && groups.has("SCHEDULING_RULES") ? from : null,
    });
    await createLocationOnlineBooking(transaction, {
      locationId,
      copyFromLocationId: from && groups.has("BOOKING_HOURS") ? from : null,
    });

    if (from) {
      if (groups.has("STATIONS_AND_ROUTING")) {
        await copyPrepStationsAndRouting(transaction, copy);
      }

      if (groups.has("MENUS")) {
        await copyMenusOffered(transaction, copy);
      }

      if (groups.has("PRICES")) {
        await copyLocationPrices(transaction, copy);
      }

      if (groups.has("TAX_RATES")) {
        await copyTaxRates(transaction, copy);
      }

      if (groups.has("STOCKED_ITEMS")) {
        await copyStockedItems(transaction, copy);
      }

      if (groups.has("TIP_POOL_RULES")) {
        await copyTipPoolRules(transaction, copy);
      }
    }

    const roleIds = await copyOwnRolesToLocation(transaction, {
      userId: actor.userId,
      fromLocationId: actor.locationId,
      toLocationId: locationId,
    });

    await recordAudit(transaction, actor, {
      action: "locations.created",
      entityId: locationId,
      after: {
        locationCode: input.locationCode,
        copiedFromLocationId: from,
        copiedGroups: [...groups].sort(),
        rolesCopied: roleIds.length,
      },
    });
    await writeOutboxEvents(transaction, [
      {
        organizationId: actor.organizationId,
        locationId,
        eventType: "location.created",
        aggregateType: "location",
        aggregateId: locationId,
        payload: { locationId },
        occurredAt: now,
      },
    ]);

    return { locationId, rolesCopied: roleIds.length };
  });
}
