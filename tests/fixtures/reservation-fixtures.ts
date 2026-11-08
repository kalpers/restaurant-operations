import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import {
  guestParties,
  locationSettings,
  partyStatusHistory,
  reservationHoldOverrides,
  reservations,
  reservationTableAssignments,
  waitlistEntries,
  waitlistTableAssignments,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  createReservation,
  type CreateReservationInput,
} from "@/modules/reservations/services/reservation-service";
import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";

import { actorWith } from "./employee-fixtures";
import {
  HOST_PERMISSIONS,
  type RestaurantScenario,
} from "./restaurant-fixtures";

/** The fixture locations all use this zone. */
export const TIME_ZONE = "America/Detroit";

/** What a front-of-house host gets from the role catalog. */
export const RESERVATION_HOST_PERMISSIONS: readonly PermissionCode[] = [
  ...HOST_PERMISSIONS,
  "reservations.view",
  "reservations.manage",
  "waitlist.view",
  "waitlist.manage",
  "waitlist.notify",
  "waitlist.seat",
];

export const RESERVATION_MANAGER_PERMISSIONS: readonly PermissionCode[] = [
  ...RESERVATION_HOST_PERMISSIONS,
  "reservations.override-hold",
  "restaurant.cancel-session",
  "restaurant.capacity.override",
];

export function reservationHost(
  database: Database,
  scenario: RestaurantScenario,
): Promise<Actor> {
  return actorWith(database, scenario, RESERVATION_HOST_PERMISSIONS);
}

export function reservationManager(
  database: Database,
  scenario: RestaurantScenario,
): Promise<Actor> {
  return actorWith(database, scenario, RESERVATION_MANAGER_PERMISSIONS);
}

/** The local date and time, as a host would type them, for an offset from now. */
export function localAt(minutesFromNow: number): {
  localDate: string;
  localTime: string;
} {
  const instant = new Date(Date.now() + minutesFromNow * 60_000);

  return {
    localDate: localDateOf(instant, TIME_ZONE),
    localTime: localTimeOf(instant, TIME_ZONE),
  };
}

export async function reserve(
  database: Database,
  actor: Actor,
  minutesFromNow: number,
  overrides: Partial<CreateReservationInput> = {},
) {
  return createReservation(database, actor, {
    guestName: "Test Guest",
    partySize: 2,
    source: "PHONE",
    expectedDurationMinutes: 60,
    ...localAt(minutesFromNow),
    ...overrides,
  });
}

export async function reservationRow(database: Database, id: string) {
  const [row] = await database
    .select()
    .from(reservations)
    .where(eq(reservations.id, id));

  return row!;
}

export async function partyRow(database: Database, id: string) {
  const [row] = await database
    .select()
    .from(guestParties)
    .where(eq(guestParties.id, id));

  return row!;
}

export function partyHistory(database: Database, partyId: string) {
  return database
    .select()
    .from(partyStatusHistory)
    .where(eq(partyStatusHistory.guestPartyId, partyId))
    .orderBy(partyStatusHistory.occurredAt, partyStatusHistory.createdAt);
}

export function plannedRows(database: Database, reservationId: string) {
  return database
    .select()
    .from(reservationTableAssignments)
    .where(eq(reservationTableAssignments.reservationId, reservationId));
}

export function waitlistPlannedRows(database: Database, entryId: string) {
  return database
    .select()
    .from(waitlistTableAssignments)
    .where(eq(waitlistTableAssignments.waitlistEntryId, entryId));
}

export async function waitlistRow(database: Database, id: string) {
  const [row] = await database
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, id));

  return row!;
}

export function holdOverrideRows(database: Database, reservationId: string) {
  return database
    .select()
    .from(reservationHoldOverrides)
    .where(eq(reservationHoldOverrides.reservationId, reservationId));
}

export async function setHoldWindows(
  database: Database,
  locationId: string,
  windows: { preHold?: number; postGrace?: number },
) {
  await database
    .update(locationSettings)
    .set({
      ...(windows.preHold !== undefined
        ? { reservationPreHoldMinutes: windows.preHold }
        : {}),
      ...(windows.postGrace !== undefined
        ? { reservationPostGraceMinutes: windows.postGrace }
        : {}),
    })
    .where(eq(locationSettings.locationId, locationId));
}
