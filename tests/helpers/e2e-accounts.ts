import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  locations,
  locationSettings,
  roles,
  userRoles,
  users,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import { clearAuditEvents } from "../fixtures/audit-cleanup";

loadLocalEnv();
pointAtTestDatabase();

const E2E_EMAIL_DOMAIN = "e2e.example.test";
const E2E_LOCATION_PREFIX = "E2E_";

export type E2eAccount = {
  id: string;
  email: string;
  password: string;
  version: number;
};

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export function uniqueE2eEmail(): string {
  return `user-${randomUUID()}@${E2E_EMAIL_DOMAIN}`;
}

async function findMainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

export async function findRoleId(roleCode: string): Promise<string> {
  const location = await findMainLocation();
  const [role] = await getDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.organizationId, location.organizationId),
        eq(roles.code, roleCode),
      ),
    );

  return role!.id;
}

/** Creates a unique account with a generated password in the test database. */
export async function createAccount(roleCode: string): Promise<E2eAccount> {
  const database = getDatabase();
  const location = await findMainLocation();
  const roleId = await findRoleId(roleCode);
  const email = uniqueE2eEmail();
  const password = generatePassword();
  const [user] = await database
    .insert(users)
    .values({
      email,
      normalizedEmail: email,
      passwordHash: await hashPassword(password),
    })
    .returning({ id: users.id, version: users.version });

  await database.insert(userRoles).values({
    userId: user!.id,
    roleId,
    locationId: location.id,
  });

  return { id: user!.id, version: user!.version, email, password };
}

/** A temporary second location. Never part of the seeded data. */
export async function createSecondLocation(): Promise<string> {
  const { organizationId } = await findMainLocation();
  const [location] = await getDatabase()
    .insert(locations)
    .values({
      organizationId,
      name: `Second ${randomUUID()}`,
      locationCode: `${E2E_LOCATION_PREFIX}${randomUUID()}`,
      timezone: "America/Detroit",
    })
    .returning({ id: locations.id });

  // Phase 17: a second location doesn't require a cash drawer.
  await getDatabase()
    .insert(locationSettings)
    .values({ locationId: location!.id, cashDrawerRequired: false });

  return location!.id;
}

export async function assignAt(
  userId: string,
  roleCode: string,
  locationId: string,
): Promise<void> {
  await getDatabase()
    .insert(userRoles)
    .values({ userId, roleId: await findRoleId(roleCode), locationId });
}

export async function findLocationName(locationId: string): Promise<string> {
  const [location] = await getDatabase()
    .select({ name: locations.name })
    .from(locations)
    .where(eq(locations.id, locationId));

  return location!.name;
}

export async function findMainLocationId(): Promise<string> {
  return (await findMainLocation()).id;
}

export async function disableAccount(userId: string): Promise<void> {
  await getDatabase()
    .update(users)
    .set({ active: false, disabledAt: new Date() })
    .where(eq(users.id, userId));
}

export async function findAccountEmails(pattern: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ email: users.email })
    .from(users)
    .where(like(users.normalizedEmail, pattern));

  return rows.map((row) => row.email);
}

/** Removes every account these tests created, including those made through the UI. */
export async function removeE2eAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${E2E_EMAIL_DOMAIN}`));
  const ids = accounts.map((account) => account.id);

  if (ids.length > 0) {
    await database.delete(userRoles).where(inArray(userRoles.userId, ids));
    await clearAuditEvents(database, { userIds: ids });
    await database.delete(users).where(inArray(users.id, ids));
  }

  const temporaryLocations = await database
    .select({ id: locations.id })
    .from(locations)
    .where(like(locations.locationCode, `${E2E_LOCATION_PREFIX}%`));
  const locationIds = temporaryLocations.map((location) => location.id);

  if (locationIds.length > 0) {
    await database
      .delete(locationSettings)
      .where(inArray(locationSettings.locationId, locationIds));
    await clearAuditEvents(database, { locationIds: locationIds });
    await database.delete(locations).where(inArray(locations.id, locationIds));
  }

  await closeDatabase();
}
