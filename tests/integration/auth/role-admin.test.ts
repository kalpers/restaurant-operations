import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { rolePermissions, roles } from "@/db/schema";
import {
  createRole,
  listRoles,
  replaceRolePermissions,
  setRoleActive,
} from "@/modules/auth/services/role-service";
import { findRolePermissionCodes } from "@/modules/auth/repositories/role-repository";
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
} from "../../fixtures/auth-fixtures";

describe("role administration", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let ownerActor: Actor;

  const roleInput = () => ({
    code: `SHIFT_LEAD_${randomUUID().replaceAll("-", "_").toUpperCase()}`,
    name: "Shift Lead",
    description: null,
  });

  beforeEach(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    const owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });

    ownerActor = await actorAt(getDatabase(), owner.id, fixture.locationA);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates a role with no permissions", async () => {
    const created = await createRole(getDatabase(), ownerActor, roleInput());

    expect(await findRolePermissionCodes(getDatabase(), created.id)).toEqual([]);
  });

  it("rejects a duplicate code within an organization", async () => {
    const input = roleInput();

    await createRole(getDatabase(), ownerActor, input);

    await expect(
      createRole(getDatabase(), ownerActor, input),
    ).rejects.toMatchObject({ code: "ROLE_CODE_EXISTS", httpStatus: 409 });
  });

  it("lists only the actor's organization, including roles with no permissions", async () => {
    const other = await createOrganizationFixture(getDatabase());
    const created = await createRole(getDatabase(), ownerActor, roleInput());
    const listed = await listRoles(getDatabase(), fixture.organizationId);
    const ids = listed.map((role) => role.id);

    expect(ids).toContain(created.id);
    expect(ids).not.toContain(other.serverRole);
    expect(listed.find((role) => role.id === created.id)?.permissions).toEqual(
      [],
    );
  });

  describe("replaceRolePermissions", () => {
    it("replaces the set and bumps the version", async () => {
      const result = await replaceRolePermissions(getDatabase(), ownerActor, {
        roleId: fixture.serverRole,
        permissions: ["kitchen.view", "menu.view"],
        expectedVersion: 1,
      });

      expect(result.version).toBe(2);
      expect(
        (
          await findRolePermissionCodes(getDatabase(), fixture.serverRole)
        ).toSorted(),
      ).toEqual(["kitchen.view", "menu.view"]);
    });

    it("can clear the set", async () => {
      await replaceRolePermissions(getDatabase(), ownerActor, {
        roleId: fixture.serverRole,
        permissions: [],
        expectedVersion: 1,
      });

      expect(
        await findRolePermissionCodes(getDatabase(), fixture.serverRole),
      ).toEqual([]);
    });

    it("rejects an unknown permission and changes nothing", async () => {
      const before = await findRolePermissionCodes(
        getDatabase(),
        fixture.serverRole,
      );

      await expect(
        replaceRolePermissions(getDatabase(), ownerActor, {
          roleId: fixture.serverRole,
          permissions: ["menu.view", "inventory.modify"],
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(
        (
          await findRolePermissionCodes(getDatabase(), fixture.serverRole)
        ).toSorted(),
      ).toEqual(before.toSorted());
    });

    it("rejects a stale version and leaves the old set in place", async () => {
      await expect(
        replaceRolePermissions(getDatabase(), ownerActor, {
          roleId: fixture.serverRole,
          permissions: [],
          expectedVersion: 99,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      expect(
        await findRolePermissionCodes(getDatabase(), fixture.serverRole),
      ).toHaveLength(2);
    });

    it("rejects another organization's role", async () => {
      const other = await createOrganizationFixture(getDatabase());

      await expect(
        replaceRolePermissions(getDatabase(), ownerActor, {
          roleId: other.serverRole,
          permissions: [],
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("stops granting a permission you lack", async () => {
      const limited = await createLimitedRoleManager();

      await expect(
        replaceRolePermissions(getDatabase(), limited, {
          roleId: fixture.serverRole,
          permissions: ["orders.create", "menu.view", "audit.view"],
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("stops removing a permission you lack", async () => {
      const limited = await createLimitedRoleManager();
      const roleId = await createRoleFixture(
        getDatabase(),
        fixture.organizationId,
        ["audit.view"],
      );

      await expect(
        replaceRolePermissions(getDatabase(), limited, {
          roleId,
          permissions: [],
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("allows changing only permissions you hold, leaving others in place", async () => {
      const limited = await createLimitedRoleManager();
      const roleId = await createRoleFixture(
        getDatabase(),
        fixture.organizationId,
        ["audit.view"],
      );

      await replaceRolePermissions(getDatabase(), limited, {
        roleId,
        permissions: ["audit.view", "menu.view"],
        expectedVersion: 1,
      });

      expect(
        (await findRolePermissionCodes(getDatabase(), roleId)).toSorted(),
      ).toEqual(["audit.view", "menu.view"]);
    });
  });

  describe("Owner role immutability", () => {
    it("rejects editing its permissions", async () => {
      await expect(
        replaceRolePermissions(getDatabase(), ownerActor, {
          roleId: fixture.ownerRole,
          permissions: [],
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "ROLE_IMMUTABLE" });

      expect(
        (await findRolePermissionCodes(getDatabase(), fixture.ownerRole)).length,
      ).toBeGreaterThan(0);
    });

    it("rejects deactivating it", async () => {
      await expect(
        setRoleActive(getDatabase(), ownerActor, {
          roleId: fixture.ownerRole,
          active: false,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "ROLE_IMMUTABLE" });
    });
  });

  describe("setRoleActive", () => {
    it("deactivates and reactivates a custom role", async () => {
      const created = await createRole(getDatabase(), ownerActor, roleInput());
      const deactivated = await setRoleActive(getDatabase(), ownerActor, {
        roleId: created.id,
        active: false,
        expectedVersion: created.version,
      });

      expect(deactivated).toMatchObject({ active: false, version: 2 });

      const [row] = await getDatabase()
        .select()
        .from(roles)
        .where(eq(roles.id, created.id));

      expect(row?.active).toBe(false);
    });

    it("rejects deactivating a system role", async () => {
      await expect(
        setRoleActive(getDatabase(), ownerActor, {
          roleId: fixture.serverRole,
          active: false,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "SYSTEM_ROLE_REQUIRED" });
    });

    it("stops deactivating a role holding permissions you lack", async () => {
      const limited = await createLimitedRoleManager();
      const roleId = await createRoleFixture(
        getDatabase(),
        fixture.organizationId,
        ["audit.view"],
      );

      await expect(
        setRoleActive(getDatabase(), limited, {
          roleId,
          active: false,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  it("makes PostgreSQL refuse to delete a role with permissions", async () => {
    await expect(
      getDatabase().delete(roles).where(eq(roles.id, fixture.serverRole)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    expect(
      await getDatabase()
        .select()
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, fixture.serverRole)),
    ).toHaveLength(2);
  });

  async function createLimitedRoleManager(): Promise<Actor> {
    const roleId = await createRoleFixture(
      getDatabase(),
      fixture.organizationId,
      ["admin.roles.manage", "orders.create", "menu.view"],
    );
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId, locationId: fixture.locationA }],
    });

    return actorAt(getDatabase(), user.id, fixture.locationA);
  }
});
