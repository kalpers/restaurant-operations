import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  locations,
  locationSettings,
  organizations,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "@/db/schema";
import { normalizeEmail } from "@/modules/auth/email";
import { hashPassword } from "@/modules/auth/password";
import {
  ALL_PERMISSION_CODES,
  type PermissionCode,
} from "@/modules/auth/permission-catalog";
import { OWNER_ROLE_CODE } from "@/modules/auth/role-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";

/** Never a known or default password: each run generates its own. */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

export async function createLocationFixture(
  database: Database,
  organizationId: string,
): Promise<string> {
  const [location] = await database
    .insert(locations)
    .values({
      organizationId,
      name: "Fixture location",
      locationCode: `FIXTURE_${randomUUID()}`,
      timezone: "America/Detroit",
    })
    .returning({ id: locations.id });

  await database.insert(locationSettings).values({ locationId: location!.id });

  return location!.id;
}

export async function createRoleFixture(
  database: Database,
  organizationId: string,
  granted: readonly PermissionCode[],
  overrides: { code?: string; systemRole?: boolean } = {},
): Promise<string> {
  const [role] = await database
    .insert(roles)
    .values({
      organizationId,
      code: overrides.code ?? `ROLE_${randomUUID()}`,
      name: "Fixture role",
      systemRole: overrides.systemRole ?? false,
    })
    .returning({ id: roles.id });

  if (granted.length > 0) {
    const rows = await database
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.code, [...granted]));

    await database
      .insert(rolePermissions)
      .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));
  }

  return role!.id;
}

export async function createUserFixture(
  database: Database,
  options: {
    email?: string;
    password?: string;
    active?: boolean;
    assignments?: { roleId: string; locationId: string; active?: boolean }[];
  } = {},
) {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? generatePassword();
  const active = options.active ?? true;

  const [user] = await database
    .insert(users)
    .values({
      email,
      normalizedEmail: normalizeEmail(email),
      passwordHash: await hashPassword(password),
      active,
      disabledAt: active ? null : new Date(),
    })
    .returning({ id: users.id, version: users.version });

  if (options.assignments?.length) {
    await database.insert(userRoles).values(
      options.assignments.map((assignment) => ({
        userId: user!.id,
        ...assignment,
      })),
    );
  }

  return { id: user!.id, version: user!.version, email, password };
}

/**
 * A separate organization with two locations, an Owner role and a limited role, so
 * tests that count Owners can't be affected by any other test's data.
 */
export async function createOrganizationFixture(database: Database) {
  const [organization] = await database
    .insert(organizations)
    .values({
      name: "Fixture organization",
      defaultTimezone: "America/Detroit",
      defaultCurrency: "USD",
    })
    .returning({ id: organizations.id });
  const organizationId = organization!.id;

  return {
    organizationId,
    locationA: await createLocationFixture(database, organizationId),
    locationB: await createLocationFixture(database, organizationId),
    ownerRole: await createRoleFixture(
      database,
      organizationId,
      ALL_PERMISSION_CODES,
      { code: OWNER_ROLE_CODE, systemRole: true },
    ),
    serverRole: await createRoleFixture(
      database,
      organizationId,
      ["orders.create", "menu.view"],
      { code: "SERVER", systemRole: true },
    ),
  };
}

/** The actor the guards would build for this user at this location. */
export async function actorAt(
  database: Database,
  userId: string,
  locationId: string,
  permission: PermissionCode = "menu.view",
): Promise<Actor> {
  const context = await getUserAuthContext(database, userId);

  if (!context) {
    throw new Error("The fixture user has no access.");
  }

  return requirePermission(context, { permission, locationId });
}

export async function findUserRow(database: Database, userId: string) {
  const [user] = await database.select().from(users).where(eq(users.id, userId));

  return user!;
}
