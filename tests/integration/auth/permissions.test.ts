import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  locations,
  organizations,
  roles,
  userRoles,
  users,
} from "@/db/schema";
import { findLocationsByCode } from "@/modules/organization/repositories/organization-repository";
import { ALL_PERMISSION_CODES } from "@/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  userHasPermission,
} from "@/modules/auth/services/permission-service";
import {
  listRoles,
  replaceRolePermissions,
} from "@/modules/auth/services/role-service";

import {
  actorAt,
  createLocationFixture,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
} from "../../fixtures/auth-fixtures";

describe("permission resolution", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;

  const check = (
    userId: string,
    permission: "orders.create" | "admin.users.manage" | "menu.view",
    locationId = fixture.locationA,
  ) => userHasPermission(getDatabase(), { userId, permission, locationId });

  beforeAll(async () => {
    fixture = await createOrganizationFixture(getDatabase());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe("seeded roles at the main location", () => {
    let mainLocation: string;
    let seededRoles: Awaited<ReturnType<typeof listRoles>>;

    const userWith = (code: string) => {
      const role = seededRoles.find((candidate) => candidate.code === code)!;

      return createUserFixture(getDatabase(), {
        assignments: [{ roleId: role.id, locationId: mainLocation }],
      });
    };

    beforeAll(async () => {
      const [main] = await findLocationsByCode(getDatabase(), "MAIN");

      mainLocation = main!.id;
      seededRoles = await listRoles(getDatabase(), main!.organizationId);
    });

    it("gives the Owner every permission", async () => {
      const owner = await userWith("OWNER");
      const context = await getUserAuthContext(getDatabase(), owner.id);

      expect(context?.locations[0]?.permissions.toSorted()).toEqual(
        [...ALL_PERMISSION_CODES].toSorted(),
      );
    });

    it("keeps owner-only administration from a Server", async () => {
      const server = await userWith("SERVER");

      for (const permission of [
        "admin.users.manage",
        "admin.roles.manage",
        "organization.manage",
        "locations.manage",
        "audit.view",
      ] as const) {
        expect(
          await userHasPermission(getDatabase(), {
            userId: server.id,
            permission,
            locationId: mainLocation,
          }),
        ).toBe(false);
      }

      expect(
        await userHasPermission(getDatabase(), {
          userId: server.id,
          permission: "orders.submit",
          locationId: mainLocation,
        }),
      ).toBe(true);
    });

    it("allows and denies by role as the matrix says", async () => {
      const cases = [
        ["HOST", "reservations.manage", true],
        ["HOST", "orders.create", false],
        ["HOST", "restaurant.seat", true],
        ["HOST", "restaurant.capacity.override", false],
        ["HOST", "restaurant.tables.manage", false],
        ["MANAGER", "restaurant.capacity.override", true],
        ["SERVER", "restaurant.seat", false],
        ["COOK", "kitchen.manage", true],
        ["COOK", "inventory.adjust", false],
        ["INVENTORY_MANAGER", "inventory.adjust", true],
        ["INVENTORY_MANAGER", "orders.void", false],
        // Phase 10: kitchen.* scopes kitchen stations and bar.* bar stations.
        ["BARTENDER", "kitchen.manage", false],
        ["BARTENDER", "bar.manage", true],
        ["BARTENDER", "fulfillment.ready", true],
        ["COOK", "bar.manage", false],
        ["COOK", "fulfillment.remake", true],
        ["SERVER", "kitchen.view", true],
        ["SERVER", "fulfillment.start", false],
        ["WAIT_STAFF", "orders.create", false],
        ["MANAGER", "schedule.publish", true],
        ["MANAGER", "hr.compensation.view", false],
        ["GENERAL_MANAGER", "admin.users.manage", true],
        ["GENERAL_MANAGER", "admin.roles.manage", false],
      ] as const;

      for (const [code, permission, expected] of cases) {
        const user = await userWith(code);

        expect(
          await userHasPermission(getDatabase(), {
            userId: user.id,
            permission,
            locationId: mainLocation,
          }),
          `${code} ${permission}`,
        ).toBe(expected);
      }
    });
  });

  it("makes a permission grant and removal effective on the next check", async () => {
    const owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });
    const roleId = await createRoleFixture(getDatabase(), fixture.organizationId, [
      "menu.view",
    ]);
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId, locationId: fixture.locationA }],
    });
    const actor = await actorAt(getDatabase(), owner.id, fixture.locationA);

    expect(await check(user.id, "orders.create")).toBe(false);

    const granted = await replaceRolePermissions(getDatabase(), actor, {
      roleId,
      permissions: ["menu.view", "orders.create"],
      expectedVersion: 1,
    });
    expect(await check(user.id, "orders.create")).toBe(true);

    await replaceRolePermissions(getDatabase(), actor, {
      roleId,
      permissions: ["menu.view"],
      expectedVersion: granted.version,
    });
    expect(await check(user.id, "orders.create")).toBe(false);
    expect(await check(user.id, "menu.view")).toBe(true);
  });

  it("ignores an inactive role", async () => {
    const roleId = await createRoleFixture(getDatabase(), fixture.organizationId, [
      "orders.create",
    ]);
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId, locationId: fixture.locationA }],
    });

    expect(await check(user.id, "orders.create")).toBe(true);

    await getDatabase()
      .update(roles)
      .set({ active: false })
      .where(eq(roles.id, roleId));

    expect(await check(user.id, "orders.create")).toBe(false);
  });

  it("denies a disabled user everything, and resolves no context", async () => {
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });

    expect(await check(user.id, "admin.users.manage")).toBe(true);

    await getDatabase()
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(eq(users.id, user.id));

    expect(await check(user.id, "admin.users.manage")).toBe(false);
    expect(await getUserAuthContext(getDatabase(), user.id)).toBeNull();
  });

  it("resolves no context for a user who doesn't exist", async () => {
    expect(
      await getUserAuthContext(
        getDatabase(),
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
  });

  it("ignores an inactive role assignment", async () => {
    const user = await createUserFixture(getDatabase(), {
      assignments: [
        {
          roleId: fixture.serverRole,
          locationId: fixture.locationA,
          active: false,
        },
      ],
    });

    expect(await check(user.id, "orders.create")).toBe(false);
    expect(
      (await getUserAuthContext(getDatabase(), user.id))?.locations,
    ).toEqual([]);
  });

  it("applies a role at its location and not at another", async () => {
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });

    expect(await check(user.id, "orders.create", fixture.locationA)).toBe(true);
    expect(await check(user.id, "orders.create", fixture.locationB)).toBe(false);
  });

  it("resolves different permissions per location for one user", async () => {
    const hostRole = await createRoleFixture(
      getDatabase(),
      fixture.organizationId,
      ["reservations.view"],
    );
    const user = await createUserFixture(getDatabase(), {
      assignments: [
        { roleId: fixture.serverRole, locationId: fixture.locationA },
        { roleId: hostRole, locationId: fixture.locationB },
      ],
    });
    const context = await getUserAuthContext(getDatabase(), user.id);
    const permissionsAt = (locationId: string) =>
      context?.locations.find((location) => location.locationId === locationId)
        ?.permissions;

    expect(permissionsAt(fixture.locationA)?.toSorted()).toEqual([
      "menu.view",
      "orders.create",
    ]);
    expect(permissionsAt(fixture.locationB)).toEqual(["reservations.view"]);
  });

  it("ignores a role at an inactive location", async () => {
    const locationId = await createLocationFixture(
      getDatabase(),
      fixture.organizationId,
    );
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId }],
    });

    expect(await check(user.id, "orders.create", locationId)).toBe(true);

    await getDatabase()
      .update(locations)
      .set({ active: false })
      .where(eq(locations.id, locationId));

    expect(await check(user.id, "orders.create", locationId)).toBe(false);
  });

  it("ignores roles at an inactive organization", async () => {
    const other = await createOrganizationFixture(getDatabase());
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: other.serverRole, locationId: other.locationA }],
    });

    await getDatabase()
      .update(organizations)
      .set({ active: false })
      .where(eq(organizations.id, other.organizationId));

    expect(
      await check(user.id, "orders.create", other.locationA),
    ).toBe(false);
  });

  it("ignores a role assigned at another organization's location", async () => {
    const other = await createOrganizationFixture(getDatabase());
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: other.serverRole, locationId: fixture.locationA }],
    });

    expect(await check(user.id, "orders.create", fixture.locationA)).toBe(false);
  });

  it("keeps a location visible for a role with no permissions", async () => {
    const roleId = await createRoleFixture(
      getDatabase(),
      fixture.organizationId,
      [],
    );
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId, locationId: fixture.locationA }],
    });
    const context = await getUserAuthContext(getDatabase(), user.id);

    expect(context?.locations).toHaveLength(1);
    expect(context?.locations[0]?.permissions).toEqual([]);
  });

  it("holds no credential data in the auth context", async () => {
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });
    const context = await getUserAuthContext(getDatabase(), user.id);
    const serialized = JSON.stringify(context);

    expect(serialized).not.toMatch(/passwordHash|password_hash|argon2/);
    expect(Object.keys(context!).sort()).toEqual([
      "active",
      "email",
      "locations",
      "mustChangePassword",
      "userId",
    ]);
  });

  it("makes PostgreSQL reject a duplicate assignment", async () => {
    const user = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });

    await expect(
      getDatabase().insert(userRoles).values({
        userId: user.id,
        roleId: fixture.serverRole,
        locationId: fixture.locationA,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const rows = await getDatabase()
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id)));

    expect(rows).toHaveLength(1);
  });
});
