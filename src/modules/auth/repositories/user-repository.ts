import { and, asc, eq, sql } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import { employees, locations, roles, userRoles, users } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** One of the two queries that read a password hash. Its result stays in the auth module. */
export async function findCredentialsByNormalizedEmail(
  executor: DatabaseExecutor,
  normalizedEmail: string,
) {
  const [user] = await executor
    .select({
      id: users.id,
      active: users.active,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail));

  return user;
}

/** Signing in isn't an edit of the record, so updated_at and version stay as they are. */
export async function recordLogin(
  executor: DatabaseExecutor,
  userId: string,
): Promise<void> {
  await executor
    .update(users)
    .set({ lastLoginAt: sql`now()`, updatedAt: sql`${users.updatedAt}` })
    .where(eq(users.id, userId));
}

export async function findUserStatusById(
  executor: DatabaseExecutor,
  userId: string,
) {
  const [user] = await executor
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, userId));

  return user;
}

/** The normalized email and version, for throttle keys and password changes. */
export async function findUserAccountById(executor: DatabaseExecutor, userId: string) {
  const [user] = await executor
    .select({
      id: users.id,
      normalizedEmail: users.normalizedEmail,
      version: users.version,
    })
    .from(users)
    .where(eq(users.id, userId));

  return user;
}

/**
 * The other query that reads a password hash, to verify a self-service change's current
 * password. Its result stays in the auth module.
 */
export async function findPasswordHashById(executor: DatabaseExecutor, userId: string) {
  const [user] = await executor
    .select({ id: users.id, normalizedEmail: users.normalizedEmail, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));

  return user;
}

/**
 * Replaces the password hash. A self-service change clears the forced-change flag; an
 * administrator's reset sets it. Either way `password_changed_at` moves, which ends every
 * older session. Returns no rows on a stale version.
 */
export function updateUserPassword(
  executor: DatabaseExecutor,
  input: {
    userId: string;
    passwordHash: string;
    mustChangePassword: boolean;
    expectedVersion?: number;
  },
) {
  return executor
    .update(users)
    .set({
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword,
      passwordChangedAt: sql`now()`,
      version: nextVersion(users.version),
    })
    .where(
      input.expectedVersion === undefined
        ? eq(users.id, input.userId)
        : and(eq(users.id, input.userId), eq(users.version, input.expectedVersion)),
    )
    .returning({
      id: users.id,
      version: users.version,
      passwordChangedAt: users.passwordChangedAt,
    });
}

export async function findUserStatusByNormalizedEmail(
  executor: DatabaseExecutor,
  normalizedEmail: string,
) {
  const [user] = await executor
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail));

  return user;
}

type NewUser = { email: string; normalizedEmail: string; passwordHash: string };

export async function insertUser(executor: DatabaseExecutor, values: NewUser) {
  const [user] = await executor
    .insert(users)
    .values(values)
    .returning({ id: users.id, email: users.email, version: users.version });

  if (!user) {
    throw new Error("User insert returned no row.");
  }

  return user;
}

/** Returns the new user's ID, or undefined if the email is already taken. */
export async function insertUserIfAbsent(
  executor: DatabaseExecutor,
  values: NewUser,
): Promise<string | undefined> {
  const [user] = await executor
    .insert(users)
    .values(values)
    .onConflictDoNothing({ target: users.normalizedEmail })
    .returning({ id: users.id });

  return user?.id;
}

/** Returns no rows when the version is stale or the user doesn't exist. */
export function updateUserActive(
  executor: DatabaseExecutor,
  input: { userId: string; active: boolean; expectedVersion: number },
) {
  return executor
    .update(users)
    .set({
      active: input.active,
      disabledAt: input.active ? null : sql`now()`,
      version: nextVersion(users.version),
    })
    .where(
      and(eq(users.id, input.userId), eq(users.version, input.expectedVersion)),
    )
    .returning({ id: users.id, active: users.active, version: users.version });
}

/** Bumps the version, so an administrator's stale re-enable can't race this. */
export async function disableUserRow(
  executor: DatabaseExecutor,
  userId: string,
): Promise<void> {
  await executor
    .update(users)
    .set({
      active: false,
      disabledAt: sql`now()`,
      version: nextVersion(users.version),
    })
    .where(and(eq(users.id, userId), eq(users.active, true)));
}

/** Read only: Employees owns the record. Undefined when the user has no employee. */
export async function findLinkedEmployeeStatus(
  executor: DatabaseExecutor,
  userId: string,
): Promise<string | undefined> {
  const [employee] = await executor
    .select({ employmentStatus: employees.employmentStatus })
    .from(employees)
    .where(eq(employees.userId, userId));

  return employee?.employmentStatus;
}

/** Users have no organization column: they belong through role assignments. */
export async function findUserInOrganization(
  executor: DatabaseExecutor,
  userId: string,
  organizationId: string,
) {
  const [user] = await executor
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(locations, eq(locations.id, userRoles.locationId))
    .where(
      and(eq(users.id, userId), eq(locations.organizationId, organizationId)),
    )
    .limit(1);

  return user;
}

/** One row per assignment, active or not. Credential columns aren't selected. */
export function findUserAssignmentRowsAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
) {
  return executor
    .select({
      id: users.id,
      email: users.email,
      normalizedEmail: users.normalizedEmail,
      active: users.active,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      version: users.version,
      roleId: roles.id,
      roleCode: roles.code,
      roleName: roles.name,
      assignmentActive: userRoles.active,
    })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.locationId, locationId))
    .orderBy(asc(users.normalizedEmail), asc(roles.code));
}

export async function hasAssignmentAtLocation(
  executor: DatabaseExecutor,
  userId: string,
  locationId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(eq(userRoles.userId, userId), eq(userRoles.locationId, locationId)),
    )
    .limit(1);

  return rows.length > 0;
}

type Assignment = {
  userId: string;
  roleId: string;
  locationId: string;
  assignedByUserId: string | null;
};

export async function insertAssignment(
  executor: DatabaseExecutor,
  values: Assignment,
): Promise<void> {
  await executor.insert(userRoles).values(values);
}

/**
 * Creates the assignment or reactivates a removed one. Returns false when it was
 * already active, which leaves its history untouched.
 */
export async function activateAssignment(
  executor: DatabaseExecutor,
  values: Assignment,
): Promise<boolean> {
  const rows = await executor
    .insert(userRoles)
    .values(values)
    .onConflictDoUpdate({
      target: [userRoles.userId, userRoles.roleId, userRoles.locationId],
      set: {
        active: true,
        assignedAt: sql`now()`,
        assignedByUserId: values.assignedByUserId,
      },
      where: eq(userRoles.active, false),
    })
    .returning({ id: userRoles.id });

  return rows.length > 0;
}

export async function deactivateAssignment(
  executor: DatabaseExecutor,
  key: { userId: string; roleId: string; locationId: string },
): Promise<void> {
  await executor
    .update(userRoles)
    .set({ active: false })
    .where(
      and(
        eq(userRoles.userId, key.userId),
        eq(userRoles.roleId, key.roleId),
        eq(userRoles.locationId, key.locationId),
      ),
    );
}

/**
 * The organizations a user belongs to, through any role assignment (active or not) or a
 * linked employee. Used to place access audit events; a user with neither has none.
 */
export async function findUserOrganizationIds(
  executor: DatabaseExecutor,
  userId: string,
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ organizationId: roles.organizationId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  const linked = await executor
    .select({ organizationId: employees.organizationId })
    .from(employees)
    .where(eq(employees.userId, userId));

  return [...new Set([...rows, ...linked].map((row) => row.organizationId))].sort();
}

/** Phase 23: the active roles one user holds at one location (active roles only). */
export async function findActiveRoleIdsAtLocation(
  executor: DatabaseExecutor,
  userId: string,
  locationId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.active, true)))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.locationId, locationId),
        eq(userRoles.active, true),
      ),
    );

  return rows.map((row) => row.roleId);
}

/**
 * Phase 23 (policy 5): active users of the organization (a role assignment at any of its
 * locations, current or removed) with no active assignment at `locationId`, matching the
 * email text. Users belong to an organization only through their assignments.
 */
export async function findOrganizationUsersNotAt(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; query: string; limit: number },
) {
  const pattern = `%${input.query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

  return executor
    .selectDistinct({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(locations, eq(locations.id, userRoles.locationId))
    .where(
      and(
        eq(locations.organizationId, input.organizationId),
        eq(users.active, true),
        sql`${users.normalizedEmail} ILIKE ${pattern}`,
        sql`NOT EXISTS (SELECT 1 FROM ${userRoles} AS here WHERE here.user_id = ${users.id} AND here.location_id = ${input.locationId} AND here.active)`,
      ),
    )
    .orderBy(asc(users.email))
    .limit(input.limit);
}

/** True when the user has, or had, a role assignment at a location of the organization. */
export async function belongsToOrganization(
  executor: DatabaseExecutor,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: userRoles.id })
    .from(userRoles)
    .innerJoin(locations, eq(locations.id, userRoles.locationId))
    .where(and(eq(userRoles.userId, userId), eq(locations.organizationId, organizationId)))
    .limit(1);

  return rows.length > 0;
}
