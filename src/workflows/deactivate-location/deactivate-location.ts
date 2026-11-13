import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { findOpenInventoryWork } from "@/modules/inventory/services/location-setup";
import {
  assertAnotherActiveLocation,
  lockLocation,
  setLocationActive,
} from "@/modules/organization/services/location-lifecycle-service";
import { findOpenOrderWork } from "@/modules/orders/services/location-work";
import { turnOffOnlineBooking } from "@/modules/reservations/services/location-setup";
import { findOpenSeatingWork } from "@/modules/restaurant/services/location-work";
import { findOpenSettlementWork } from "@/modules/settlements/services/location-setup";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";

// Phase 23 (policy 3, D3): closing a location. Never a delete: the location is marked
// inactive, so it leaves everyone's switcher and grants, and its history stays. Refused
// while anything is still open there (each module answers for its own work) and for the
// organization's last active location. Online booking is turned off with it.

export async function deactivateLocation(
  database: Database,
  actor: Actor,
  input: { locationId: string; expectedVersion: number },
  now = new Date(),
): Promise<{ version: number }> {
  const allowed =
    actor.permissions.has("locations.lifecycle") &&
    (input.locationId === actor.locationId ||
      (await userHasPermission(database, {
        userId: actor.userId,
        permission: "locations.lifecycle",
        locationId: input.locationId,
      })));

  if (!allowed) {
    throw new AuthorizationError();
  }

  return withTransaction(database, async (transaction) => {
    const location = await lockLocation(transaction, {
      organizationId: actor.organizationId,
      locationId: input.locationId,
      expectedVersion: input.expectedVersion,
    });

    if (!location.active) {
      throw new BusinessRuleError("LOCATION_INACTIVE", "This location is already closed.");
    }

    await assertAnotherActiveLocation(transaction, actor.organizationId);

    const open = [
      ...(await findOpenOrderWork(transaction, input.locationId)),
      ...(await findOpenSeatingWork(transaction, input.locationId)),
      ...(await findOpenSettlementWork(transaction, input.locationId)),
      ...(await findOpenInventoryWork(transaction, input.locationId)),
    ];

    if (open.length > 0) {
      const error = new BusinessRuleError(
        "LOCATION_HAS_OPEN_WORK",
        `Finish these at ${location.locationCode} first: ${open.join(", ")}.`,
      );

      error.details = { open };
      throw error;
    }

    const version = await setLocationActive(transaction, input.locationId, false);

    await turnOffOnlineBooking(transaction, input.locationId);
    await recordAudit(transaction, actor, {
      action: "locations.deactivated",
      entityId: input.locationId,
      after: { locationCode: location.locationCode, active: false },
    });
    await writeOutboxEvents(transaction, [
      {
        organizationId: actor.organizationId,
        locationId: input.locationId,
        eventType: "location.deactivated",
        aggregateType: "location",
        aggregateId: input.locationId,
        payload: { locationId: input.locationId },
        occurredAt: now,
      },
    ]);

    return { version };
  });
}
