import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { userRoles, users } from "@/db/schema";
import { normalizeEmail } from "@/modules/auth/email";
import { ALL_PERMISSION_CODES } from "@/modules/auth/permission-catalog";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import {
  assignRole,
  createUserWithRole,
  listUsersAtLocation,
  removeRole,
  setUserActive,
} from "@/modules/auth/services/user-service";
import type { Actor } from "@/modules/auth/types";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  findUserRow,
  generatePassword,
  uniqueEmail,
} from "../../fixtures/auth-fixtures";

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

describe("user administration", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let owner: Awaited<ReturnType<typeof createUserFixture>>;
  let ownerActor: Actor;

  /** Holds user management and little else, like a General Manager. */
  async function createLimitedAdmin() {
    const roleId = await createRoleFixture(getDatabase(), fixture.organizationId, [
      "admin.users.view",
      "admin.users.manage",
      "orders.create",
      "menu.view",
    ]);
    const admin = await createUserFixture(getDatabase(), {
      assignments: [{ roleId, locationId: fixture.locationA }],
    });

    return {
      admin,
      actor: await actorAt(getDatabase(), admin.id, fixture.locationA),
    };
  }

  const createServer = () =>
    createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });

  beforeEach(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });
    ownerActor = await actorAt(getDatabase(), owner.id, fixture.locationA);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe("createUserWithRole", () => {
    it("creates the account and its role at the actor's location", async () => {
      const email = `  New.User-${generatePassword()}@Example.test `;
      const password = generatePassword();

      const created = await createUserWithRole(getDatabase(), ownerActor, {
        email,
        password,
        roleId: fixture.serverRole,
      });
      const row = await findUserRow(getDatabase(), created.id);

      expect(row.normalizedEmail).toBe(normalizeEmail(email));
      expect(row.email).toBe(email.trim());
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(Object.keys(created).sort()).toEqual(["email", "id", "version"]);
      expect(
        await userHasPermission(getDatabase(), {
          userId: created.id,
          permission: "orders.create",
          locationId: fixture.locationA,
        }),
      ).toBe(true);
      expect(
        await userHasPermission(getDatabase(), {
          userId: created.id,
          permission: "orders.create",
          locationId: fixture.locationB,
        }),
      ).toBe(false);
    });

    it("rejects a duplicate that differs only by case", async () => {
      const email = uniqueEmail();

      await createUserWithRole(getDatabase(), ownerActor, {
        email,
        password: generatePassword(),
        roleId: fixture.serverRole,
      });

      await expect(
        createUserWithRole(getDatabase(), ownerActor, {
          email: email.toUpperCase(),
          password: generatePassword(),
          roleId: fixture.serverRole,
        }),
      ).rejects.toMatchObject({ code: "EMAIL_ALREADY_EXISTS", httpStatus: 409 });
    });

    it("rejects a short password", async () => {
      await expect(
        createUserWithRole(getDatabase(), ownerActor, {
          email: uniqueEmail(),
          password: "x".repeat(13),
          roleId: fixture.serverRole,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a role from another organization and creates nothing", async () => {
      const other = await createOrganizationFixture(getDatabase());
      const email = uniqueEmail();

      await expect(
        createUserWithRole(getDatabase(), ownerActor, {
          email,
          password: generatePassword(),
          roleId: other.serverRole,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(
        await getDatabase()
          .select()
          .from(users)
          .where(eq(users.normalizedEmail, normalizeEmail(email))),
      ).toEqual([]);
    });

    it("rolls back the account when the role assignment fails", async () => {
      const email = uniqueEmail();
      const actorAtMissingLocation = { ...ownerActor, locationId: ABSENT_ID };

      await expect(
        createUserWithRole(getDatabase(), actorAtMissingLocation, {
          email,
          password: generatePassword(),
          roleId: fixture.serverRole,
        }),
      ).rejects.toThrow();

      expect(
        await getDatabase()
          .select()
          .from(users)
          .where(eq(users.normalizedEmail, normalizeEmail(email))),
      ).toEqual([]);
    });
  });

  describe("listUsersAtLocation", () => {
    it("lists users at this location only, with no credential fields", async () => {
      const server = await createServer();
      const elsewhere = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.serverRole, locationId: fixture.locationB },
        ],
      });

      const listed = await listUsersAtLocation(getDatabase(), fixture.locationA);
      const ids = listed.map((user) => user.id);

      expect(ids).toContain(server.id);
      expect(ids).not.toContain(elsewhere.id);
      expect(JSON.stringify(listed)).not.toMatch(
        /passwordHash|password_hash|argon2/,
      );
    });

    it("keeps a user with no remaining role, showing no roles", async () => {
      const server = await createServer();

      await removeRole(getDatabase(), ownerActor, {
        userId: server.id,
        roleId: fixture.serverRole,
      });

      const listed = await listUsersAtLocation(getDatabase(), fixture.locationA);

      expect(listed.find((user) => user.id === server.id)?.roles).toEqual([]);
    });
  });

  describe("setUserActive", () => {
    it("disables and re-enables, keeping active and disabled_at in step", async () => {
      const server = await createServer();

      const disabled = await setUserActive(getDatabase(), ownerActor, {
        userId: server.id,
        active: false,
        expectedVersion: server.version,
      });

      expect(disabled).toMatchObject({ active: false, version: 2 });
      expect(
        (await findUserRow(getDatabase(), server.id)).disabledAt,
      ).toBeInstanceOf(Date);

      await setUserActive(getDatabase(), ownerActor, {
        userId: server.id,
        active: true,
        expectedVersion: disabled.version,
      });

      expect((await findUserRow(getDatabase(), server.id)).disabledAt).toBeNull();
    });

    it("rejects disabling yourself", async () => {
      await expect(
        setUserActive(getDatabase(), ownerActor, {
          userId: owner.id,
          active: false,
          expectedVersion: owner.version,
        }),
      ).rejects.toMatchObject({ code: "SELF_DISABLE_NOT_ALLOWED" });
    });

    it("rejects a stale version", async () => {
      const server = await createServer();

      await expect(
        setUserActive(getDatabase(), ownerActor, {
          userId: server.id,
          active: false,
          expectedVersion: server.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("lets only one of two simultaneous updates win", async () => {
      const server = await createServer();
      const update = () =>
        setUserActive(getDatabase(), ownerActor, {
          userId: server.id,
          active: false,
          expectedVersion: server.version,
        });

      const results = await Promise.allSettled([update(), update()]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    });

    it("rejects a user with no assignment at this location", async () => {
      const elsewhere = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.serverRole, locationId: fixture.locationB },
        ],
      });

      await expect(
        setUserActive(getDatabase(), ownerActor, {
          userId: elsewhere.id,
          active: false,
          expectedVersion: elsewhere.version,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("no-escalation rule", () => {
    it("stops assigning a role that holds permissions you lack", async () => {
      const { actor } = await createLimitedAdmin();
      const server = await createServer();

      await expect(
        assignRole(getDatabase(), actor, {
          userId: server.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("stops you giving yourself the Owner role", async () => {
      const { admin, actor } = await createLimitedAdmin();

      await expect(
        assignRole(getDatabase(), actor, {
          userId: admin.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("stops creating an account with a role beyond yours", async () => {
      const { actor } = await createLimitedAdmin();
      const email = uniqueEmail();

      await expect(
        createUserWithRole(getDatabase(), actor, {
          email,
          password: generatePassword(),
          roleId: fixture.ownerRole,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);

      expect(
        await getDatabase()
          .select()
          .from(users)
          .where(eq(users.normalizedEmail, normalizeEmail(email))),
      ).toEqual([]);
    });

    it("allows a role within what you hold", async () => {
      const { actor } = await createLimitedAdmin();
      const user = await createUserFixture(getDatabase());

      await assignRole(getDatabase(), actor, {
        userId: user.id,
        roleId: fixture.serverRole,
      });

      expect(
        await userHasPermission(getDatabase(), {
          userId: user.id,
          permission: "orders.create",
          locationId: fixture.locationA,
        }),
      ).toBe(true);
    });

    it("stops disabling someone who holds permissions you lack", async () => {
      const { actor } = await createLimitedAdmin();
      const otherOwner = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
        ],
      });

      await expect(
        setUserActive(getDatabase(), actor, {
          userId: otherOwner.id,
          active: false,
          expectedVersion: otherOwner.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("counts the permissions someone holds at other locations", async () => {
      const { actor } = await createLimitedAdmin();
      const ownerElsewhere = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.serverRole, locationId: fixture.locationA },
          { roleId: fixture.ownerRole, locationId: fixture.locationB },
        ],
      });

      await expect(
        setUserActive(getDatabase(), actor, {
          userId: ownerElsewhere.id,
          active: false,
          expectedVersion: ownerElsewhere.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("stops removing a role that holds permissions you lack", async () => {
      const { actor } = await createLimitedAdmin();
      const otherOwner = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
        ],
      });

      await expect(
        removeRole(getDatabase(), actor, {
          userId: otherOwner.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("last-owner protection", () => {
    it("stops the last Owner losing the role", async () => {
      await expect(
        removeRole(getDatabase(), ownerActor, {
          userId: owner.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toMatchObject({ code: "LAST_OWNER" });
    });

    it("allows removal while another active Owner remains", async () => {
      const second = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
        ],
      });

      await removeRole(getDatabase(), ownerActor, {
        userId: second.id,
        roleId: fixture.ownerRole,
      });

      await expect(
        removeRole(getDatabase(), ownerActor, {
          userId: owner.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toMatchObject({ code: "LAST_OWNER" });
    });

    it("doesn't count a disabled Owner as remaining", async () => {
      await createUserFixture(getDatabase(), {
        active: false,
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
        ],
      });

      await expect(
        removeRole(getDatabase(), ownerActor, {
          userId: owner.id,
          roleId: fixture.ownerRole,
        }),
      ).rejects.toMatchObject({ code: "LAST_OWNER" });
    });

    /** Holds every permission without being an Owner, so only this rule can refuse. */
    async function createFullAccessNonOwner(): Promise<Actor> {
      const roleId = await createRoleFixture(
        getDatabase(),
        fixture.organizationId,
        ALL_PERMISSION_CODES,
      );
      const user = await createUserFixture(getDatabase(), {
        assignments: [{ roleId, locationId: fixture.locationA }],
      });

      return actorAt(getDatabase(), user.id, fixture.locationA);
    }

    it("stops disabling the last active Owner", async () => {
      const actor = await createFullAccessNonOwner();

      await expect(
        setUserActive(getDatabase(), actor, {
          userId: owner.id,
          active: false,
          expectedVersion: owner.version,
        }),
      ).rejects.toMatchObject({ code: "LAST_OWNER" });

      expect((await findUserRow(getDatabase(), owner.id)).active).toBe(true);
    });

    it("allows disabling an Owner while another remains", async () => {
      const actor = await createFullAccessNonOwner();

      await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationB },
        ],
      });

      await expect(
        setUserActive(getDatabase(), actor, {
          userId: owner.id,
          active: false,
          expectedVersion: owner.version,
        }),
      ).resolves.toMatchObject({ active: false });
    });

    it("counts an Owner's assignment at another location as remaining", async () => {
      await getDatabase().insert(userRoles).values({
        userId: owner.id,
        roleId: fixture.ownerRole,
        locationId: fixture.locationB,
      });

      await expect(
        removeRole(getDatabase(), ownerActor, {
          userId: owner.id,
          roleId: fixture.ownerRole,
        }),
      ).resolves.toBeUndefined();

      expect(
        await userHasPermission(getDatabase(), {
          userId: owner.id,
          permission: "admin.roles.manage",
          locationId: fixture.locationB,
        }),
      ).toBe(true);
    });

    it("lets only one of two Owners remove the other at the same moment", async () => {
      const second = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
        ],
      });
      const secondActor = await actorAt(
        getDatabase(),
        second.id,
        fixture.locationA,
      );

      const results = await Promise.allSettled([
        removeRole(getDatabase(), ownerActor, {
          userId: second.id,
          roleId: fixture.ownerRole,
        }),
        removeRole(getDatabase(), secondActor, {
          userId: owner.id,
          roleId: fixture.ownerRole,
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);

      const remaining = await getDatabase()
        .select()
        .from(userRoles)
        .where(eq(userRoles.roleId, fixture.ownerRole));

      expect(remaining.filter((row) => row.active)).toHaveLength(1);
    });
  });

  describe("assignRole and removeRole", () => {
    it("reactivates a removed assignment rather than adding a row", async () => {
      const server = await createServer();
      const key = { userId: server.id, roleId: fixture.serverRole };

      await removeRole(getDatabase(), ownerActor, key);
      await assignRole(getDatabase(), ownerActor, key);

      const rows = await getDatabase()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, server.id));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        active: true,
        assignedByUserId: owner.id,
      });
    });

    it("changes nothing when assigning a role already held", async () => {
      const server = await createServer();
      const key = { userId: server.id, roleId: fixture.serverRole };
      const [before] = await getDatabase()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, server.id));

      await assignRole(getDatabase(), ownerActor, key);

      const rows = await getDatabase()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, server.id));

      expect(rows).toEqual([before]);
    });

    it("removes at the actor's location only", async () => {
      const user = await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.serverRole, locationId: fixture.locationA },
          { roleId: fixture.serverRole, locationId: fixture.locationB },
        ],
      });

      await removeRole(getDatabase(), ownerActor, {
        userId: user.id,
        roleId: fixture.serverRole,
      });

      const allowedAt = (locationId: string) =>
        userHasPermission(getDatabase(), {
          userId: user.id,
          permission: "orders.create",
          locationId,
        });

      expect(await allowedAt(fixture.locationA)).toBe(false);
      expect(await allowedAt(fixture.locationB)).toBe(true);
    });

    it("rejects removing an assignment the user doesn't hold", async () => {
      const user = await createUserFixture(getDatabase());

      await expect(
        removeRole(getDatabase(), ownerActor, {
          userId: user.id,
          roleId: fixture.serverRole,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects assigning to a user who doesn't exist", async () => {
      await expect(
        assignRole(getDatabase(), ownerActor, {
          userId: ABSENT_ID,
          roleId: fixture.serverRole,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
