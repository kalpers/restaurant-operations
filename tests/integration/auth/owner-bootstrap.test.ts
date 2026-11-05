import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import { closeDatabase, getDatabase, type Database } from "@/db";
import { applyMigrations } from "@/db/maintenance/apply-migrations";
import * as schema from "@/db/schema";
import { roles, userRoles, users } from "@/db/schema";
import { verifyCredentials } from "@/modules/auth/services/credential-service";
import { bootstrapOwner } from "@/modules/auth/services/owner-bootstrap";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import { ValidationError } from "@/shared/errors/app-error";

import {
  findUserRow,
  generatePassword,
  uniqueEmail,
} from "../../fixtures/auth-fixtures";
import {
  dropDatabase,
  recreateEmptyDatabase,
} from "../../helpers/prepare-test-database";

const EMPTY_DATABASE = "restaurant_ops_test_bootstrap";

async function findUserIdByEmail(email: string): Promise<string> {
  const [user] = await getDatabase()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.normalizedEmail, email.toLowerCase()));

  return user!.id;
}

describe("bootstrapOwner", () => {
  afterAll(async () => {
    await closeDatabase();
    await dropDatabase(requireTestDatabaseUrl(), EMPTY_DATABASE);
  });

  it("creates an Owner who can sign in and holds Owner permissions", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    expect(await bootstrapOwner(getDatabase(), input)).toEqual({
      userCreated: true,
      roleAssigned: true,
    });

    const signedIn = await verifyCredentials(getDatabase(), input);
    expect(signedIn).not.toBeNull();

    const [assignment] = await getDatabase()
      .select({ locationId: userRoles.locationId })
      .from(userRoles)
      .where(eq(userRoles.userId, signedIn!.id));

    expect(
      await userHasPermission(getDatabase(), {
        userId: signedIn!.id,
        permission: "admin.roles.manage",
        locationId: assignment!.locationId,
      }),
    ).toBe(true);
  });

  it("is safe to run again, with no duplicates and no password change", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    await bootstrapOwner(getDatabase(), input);
    const userId = await findUserIdByEmail(input.email);
    const hashBefore = (await findUserRow(getDatabase(), userId)).passwordHash;

    const second = await bootstrapOwner(getDatabase(), {
      email: input.email.toUpperCase(),
      password: generatePassword(),
    });

    expect(second).toEqual({ userCreated: false, roleAssigned: false });
    expect((await findUserRow(getDatabase(), userId)).passwordHash).toBe(
      hashBefore,
    );
    expect(await verifyCredentials(getDatabase(), input)).toEqual({ id: userId });
    expect(
      await getDatabase()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, userId)),
    ).toHaveLength(1);
  });

  it("restores a removed Owner assignment on retry", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    await bootstrapOwner(getDatabase(), input);
    const userId = await findUserIdByEmail(input.email);

    await getDatabase()
      .update(userRoles)
      .set({ active: false })
      .where(eq(userRoles.userId, userId));

    expect(await bootstrapOwner(getDatabase(), input)).toEqual({
      userCreated: false,
      roleAssigned: true,
    });
  });

  it("creates one account across simultaneous runs", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    const results = await Promise.all([
      bootstrapOwner(getDatabase(), input),
      bootstrapOwner(getDatabase(), input),
    ]);

    expect(results.filter((result) => result.userCreated)).toHaveLength(1);
    expect(
      await getDatabase()
        .select()
        .from(users)
        .where(eq(users.normalizedEmail, input.email.toLowerCase())),
    ).toHaveLength(1);
  });

  it("won't re-enable a disabled account", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    await bootstrapOwner(getDatabase(), input);
    const userId = await findUserIdByEmail(input.email);

    await getDatabase()
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(eq(users.id, userId));

    await expect(bootstrapOwner(getDatabase(), input)).rejects.toMatchObject({
      code: "BOOTSTRAP_USER_DISABLED",
    });
    expect((await findUserRow(getDatabase(), userId)).active).toBe(false);
  });

  it("rejects a short password and a malformed email", async () => {
    await expect(
      bootstrapOwner(getDatabase(), {
        email: uniqueEmail(),
        password: "x".repeat(13),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      bootstrapOwner(getDatabase(), {
        email: "not-an-email",
        password: generatePassword(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails clearly, without creating an account, when seeds are missing", async () => {
    const url = await recreateEmptyDatabase(
      requireTestDatabaseUrl(),
      EMPTY_DATABASE,
    );

    await applyMigrations(url);

    const client = postgres(url, { max: 1, onnotice: () => {} });
    const database = drizzle(client, { schema }) as unknown as Database;

    try {
      await expect(
        bootstrapOwner(database, {
          email: uniqueEmail(),
          password: generatePassword(),
        }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_FOUNDATION_MISSING" });

      expect(await database.select().from(users)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("assigns the seeded Owner role, identified by its code", async () => {
    const input = { email: uniqueEmail("owner"), password: generatePassword() };

    await bootstrapOwner(getDatabase(), input);
    const userId = await findUserIdByEmail(input.email);

    const rows = await getDatabase()
      .select({ code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, userId), eq(userRoles.active, true)));

    expect(rows).toEqual([{ code: "OWNER" }]);
  });
});
