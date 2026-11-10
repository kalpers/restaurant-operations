import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, like, or } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  guestParties,
  locations,
  partyStatusHistory,
  permissions,
  reservationHoldOverrides,
  reservations,
  reservationTableAssignments,
  restaurantAreas,
  restaurantTables,
  rolePermissions,
  roles,
  tableConditionHistory,
  tableSessionOverrides,
  tableSessions,
  tableSessionTables,
  userRoles,
  users,
  waitlistEntries,
  waitlistTableAssignments,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import {
  createReservation,
  type CreateReservationInput,
} from "../../src/modules/reservations/services/reservation-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { localDateOf, localTimeOf } from "../../src/shared/time/zoned-time";
import { clearAuditEvents } from "../fixtures/audit-cleanup";

loadLocalEnv();
pointAtTestDatabase();

// Its own markers: spec files run in parallel and each removes only what it created.
const EMAIL_DOMAIN = "reservations-e2e.example.test";
const ROLE_PREFIX = "RESERVATIONS_E2E_";
export const TABLE_PREFIX = "RSV-";
export const GUEST_PREFIX = "Rsv ";
export const TIME_ZONE = "America/Detroit";

export type ReservationAccount = { id: string; email: string; password: string };

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<ReservationAccount> {
  const database = getDatabase();
  const location = await mainLocation();
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const password = randomBytes(24).toString("base64url");
  const [user] = await database
    .insert(users)
    .values({
      email,
      normalizedEmail: email,
      passwordHash: await hashPassword(password),
    })
    .returning({ id: users.id });

  await database
    .insert(userRoles)
    .values({ userId: user!.id, roleId, locationId: location.id });

  return { id: user!.id, email, password };
}

export async function createRoleAccount(
  roleCode: string,
): Promise<ReservationAccount> {
  const [role] = await getDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

export async function createPermissionAccount(
  codes: readonly PermissionCode[],
): Promise<ReservationAccount> {
  const database = getDatabase();
  const { organizationId } = await mainLocation();
  const [role] = await database
    .insert(roles)
    .values({
      organizationId,
      code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Reservations E2E fixture",
    })
    .returning({ id: roles.id });
  const rows = await database
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  if (rows.length > 0) {
    await database
      .insert(rolePermissions)
      .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));
  }

  return insertAccount(role!.id);
}

async function actorFor(account: ReservationAccount): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, {
    permission: "reservations.manage",
    locationId: location.id,
  });
}

async function areaIdOf(code: string): Promise<string> {
  const location = await mainLocation();
  const [area] = await getDatabase()
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(
      and(
        eq(restaurantAreas.locationId, location.id),
        eq(restaurantAreas.code, code),
      ),
    );

  return area!.id;
}

/** A table only this spec uses, so the seeded floor and other specs aren't touched. */
export async function createRsvTable(
  owner: ReservationAccount,
  options: { capacity?: number; areaCode?: string } = {},
): Promise<{ id: string; tableNumber: string }> {
  const tableNumber = `${TABLE_PREFIX}${randomUUID().slice(0, 8)}`;
  const { id } = await createTable(getDatabase(), await actorFor(owner), {
    restaurantAreaId: await areaIdOf(options.areaCode ?? "DINING_ROOM"),
    tableNumber,
    name: null,
    capacity: options.capacity ?? 4,
    minimumCapacity: null,
    sortOrder: null,
  });

  return { id, tableNumber };
}

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

export function guestName(label = "Guest"): string {
  return `${GUEST_PREFIX}${label} ${randomUUID().slice(0, 6)}`;
}

/** A reservation made directly through the service, for set-up that isn't under test. */
export async function reserveAt(
  owner: ReservationAccount,
  minutesFromNow: number,
  overrides: Partial<CreateReservationInput> = {},
) {
  return createReservation(getDatabase(), await actorFor(owner), {
    guestName: guestName(),
    partySize: 2,
    source: "PHONE",
    expectedDurationMinutes: 60,
    ...localAt(minutesFromNow),
    ...overrides,
  });
}

export async function reservationOf(id: string) {
  const [row] = await getDatabase()
    .select()
    .from(reservations)
    .where(eq(reservations.id, id));

  return row!;
}

export async function reservationNamed(name: string) {
  const [party] = await getDatabase()
    .select()
    .from(guestParties)
    .where(eq(guestParties.guestName, name));
  const [reservation] = await getDatabase()
    .select()
    .from(reservations)
    .where(eq(reservations.guestPartyId, party!.id));

  return { party: party!, reservation: reservation! };
}

export async function plannedTableIds(reservationId: string) {
  const rows = await getDatabase()
    .select()
    .from(reservationTableAssignments)
    .where(eq(reservationTableAssignments.reservationId, reservationId));

  return rows.map((row) => ({
    tableId: row.restaurantTableId,
    ended: row.removedAt !== null,
    reason: row.removalReason,
  }));
}

export async function waitlistEntryFor(name: string) {
  const [party] = await getDatabase()
    .select()
    .from(guestParties)
    .where(eq(guestParties.guestName, name));
  const [entry] = await getDatabase()
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.guestPartyId, party!.id));

  return { party: party!, entry: entry! };
}

export async function holdOverridesFor(reservationId: string) {
  return getDatabase()
    .select()
    .from(reservationHoldOverrides)
    .where(eq(reservationHoldOverrides.reservationId, reservationId));
}

export async function openSessionIdsAt(tableId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({
      sessionId: tableSessionTables.tableSessionId,
      leftAt: tableSessionTables.leftAt,
    })
    .from(tableSessionTables)
    .where(eq(tableSessionTables.restaurantTableId, tableId));

  return rows.filter((row) => row.leftAt === null).map((row) => row.sessionId);
}

export async function sessionPartyAt(tableId: string): Promise<string | null> {
  const [ids] = [await openSessionIdsAt(tableId)];

  if (ids.length === 0) {
    return null;
  }

  const [session] = await getDatabase()
    .select({ guestPartyId: tableSessions.guestPartyId })
    .from(tableSessions)
    .where(eq(tableSessions.id, ids[0]!));

  return session?.guestPartyId ?? null;
}

export async function removeReservationE2eData(): Promise<void> {
  const database = getDatabase();
  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));
  const userIds = accounts.map((row) => row.id);
  const tableRows = await database
    .select({ id: restaurantTables.id })
    .from(restaurantTables)
    .where(like(restaurantTables.tableNumber, `${TABLE_PREFIX}%`));
  const tableIds = tableRows.map((row) => row.id);
  const parties = await database
    .select({ id: guestParties.id })
    .from(guestParties)
    .where(like(guestParties.guestName, `${GUEST_PREFIX}%`));
  const partyIds = parties.map((row) => row.id);

  if (partyIds.length) {
    const reservationRows = await database
      .select({ id: reservations.id })
      .from(reservations)
      .where(inArray(reservations.guestPartyId, partyIds));
    const reservationIds = reservationRows.map((row) => row.id);
    const entryRows = await database
      .select({ id: waitlistEntries.id })
      .from(waitlistEntries)
      .where(inArray(waitlistEntries.guestPartyId, partyIds));
    const entryIds = entryRows.map((row) => row.id);
    const sessionRows = await database
      .select({ id: tableSessions.id })
      .from(tableSessions)
      .where(
        or(
          inArray(tableSessions.guestPartyId, partyIds),
          userIds.length ? inArray(tableSessions.createdByUserId, userIds) : undefined,
        ),
      );
    const sessionIds = sessionRows.map((row) => row.id);

    if (reservationIds.length) {
      await database.delete(reservationHoldOverrides).where(inArray(reservationHoldOverrides.reservationId, reservationIds));
      await database.delete(reservationTableAssignments).where(inArray(reservationTableAssignments.reservationId, reservationIds));
    }

    if (sessionIds.length) {
      await database.delete(reservationHoldOverrides).where(inArray(reservationHoldOverrides.tableSessionId, sessionIds));
    }

    if (entryIds.length) {
      await database.delete(waitlistTableAssignments).where(inArray(waitlistTableAssignments.waitlistEntryId, entryIds));
      await database.delete(waitlistEntries).where(inArray(waitlistEntries.id, entryIds));
    }

    if (reservationIds.length) {
      await database.delete(reservations).where(inArray(reservations.id, reservationIds));
    }

    if (sessionIds.length) {
      await database.delete(tableSessionOverrides).where(inArray(tableSessionOverrides.tableSessionId, sessionIds));
      await database.delete(tableSessionTables).where(inArray(tableSessionTables.tableSessionId, sessionIds));
      await database.delete(tableSessions).where(inArray(tableSessions.id, sessionIds));
    }

    await database.delete(partyStatusHistory).where(inArray(partyStatusHistory.guestPartyId, partyIds));
    await database.delete(guestParties).where(inArray(guestParties.id, partyIds));
  }

  if (tableIds.length) {
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.restaurantTableId, tableIds));
    await database.delete(restaurantTables).where(inArray(restaurantTables.id, tableIds));
  }

  if (userIds.length) {
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.changedByUserId, userIds));
    await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
    await clearAuditEvents(database, { userIds: userIds });
    await database.delete(users).where(inArray(users.id, userIds));
  }

  const fixtureRoles = await database
    .select({ id: roles.id })
    .from(roles)
    .where(like(roles.code, `${ROLE_PREFIX}%`));
  const roleIds = fixtureRoles.map((row) => row.id);

  if (roleIds.length) {
    await database.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await database.delete(roles).where(inArray(roles.id, roleIds));
  }

  await closeDatabase();
}
