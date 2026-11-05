import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { users } from "@/db/schema";
import { verifyCredentials } from "@/modules/auth/services/credential-service";

import {
  createUserFixture,
  findUserRow,
  generatePassword,
  uniqueEmail,
} from "../../fixtures/auth-fixtures";

describe("verifyCredentials", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("accepts valid credentials and returns only the ID", async () => {
    const user = await createUserFixture(getDatabase());

    expect(await verifyCredentials(getDatabase(), user)).toEqual({ id: user.id });
  });

  it("finds the account whatever the email's casing or spacing", async () => {
    const user = await createUserFixture(getDatabase());

    expect(
      await verifyCredentials(getDatabase(), {
        email: `  ${user.email.toUpperCase()} `,
        password: user.password,
      }),
    ).toEqual({ id: user.id });
  });

  it("returns the same null for a wrong password, unknown email and disabled user", async () => {
    const enabled = await createUserFixture(getDatabase());
    const disabled = await createUserFixture(getDatabase(), { active: false });

    const results = await Promise.all([
      verifyCredentials(getDatabase(), {
        email: enabled.email,
        password: generatePassword(),
      }),
      verifyCredentials(getDatabase(), {
        email: uniqueEmail("unknown"),
        password: generatePassword(),
      }),
      verifyCredentials(getDatabase(), {
        email: disabled.email,
        password: disabled.password,
      }),
    ]);

    expect(results).toEqual([null, null, null]);
  });

  it("rejects an oversized password without hashing it", async () => {
    const user = await createUserFixture(getDatabase());

    expect(
      await verifyCredentials(getDatabase(), {
        email: user.email,
        password: "x".repeat(1025),
      }),
    ).toBeNull();
  });

  it("records the login without changing the version or updated_at", async () => {
    const user = await createUserFixture(getDatabase());
    const before = await findUserRow(getDatabase(), user.id);

    expect(before.lastLoginAt).toBeNull();
    await verifyCredentials(getDatabase(), user);

    const after = await findUserRow(getDatabase(), user.id);

    expect(after.lastLoginAt).toBeInstanceOf(Date);
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("doesn't record a login after a failed attempt", async () => {
    const user = await createUserFixture(getDatabase());

    await verifyCredentials(getDatabase(), {
      email: user.email,
      password: generatePassword(),
    });

    expect((await findUserRow(getDatabase(), user.id)).lastLoginAt).toBeNull();
  });

  it("never stores the plaintext password", async () => {
    const user = await createUserFixture(getDatabase());
    const row = await findUserRow(getDatabase(), user.id);

    expect(row.passwordHash).not.toContain(user.password);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("makes PostgreSQL reject a duplicate normalized email", async () => {
    const user = await createUserFixture(getDatabase());

    await expect(
      getDatabase().insert(users).values({
        email: user.email.toUpperCase(),
        normalizedEmail: user.email.toLowerCase(),
        passwordHash: "unused",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("makes PostgreSQL reject active and disabled_at disagreeing", async () => {
    await expect(
      getDatabase().insert(users).values({
        email: uniqueEmail(),
        normalizedEmail: uniqueEmail(),
        passwordHash: "unused",
        active: true,
        disabledAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
