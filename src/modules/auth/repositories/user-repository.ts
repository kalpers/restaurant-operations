import { and, asc, eq, sql } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import { roles, userRoles, users } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** The only query that reads a password hash. Its result stays in the auth module. */
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

/** One row per assignment, active or not. Credential columns aren't selected. */
export function findUserAssignmentRowsAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
) {
  return executor
    .select({
      id: users.id,
      email: users.email,
      active: users.active,
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
