import { and, count, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import type { Database } from "@/db";
import { applyMigrations } from "@/db/maintenance/apply-migrations";
import * as schema from "@/db/schema";
import {
  certificationTypes,
  employees,
  locations,
  locationSettings,
  organizations,
  permissions,
  positions,
  rolePermissions,
  roles,
  restaurantAreas,
  schedulingRules,
  seedRuns,
  users,
} from "@/db/schema";
import { securityGuestMessagingPermissionsSeed } from "@/db/seeds/guest-messaging-permissions";
import { securityLocationsLotsPermissionsSeed } from "@/db/seeds/locations-lots-permissions";
import { seeds } from "@/db/seeds/registry";
import { runSeeds } from "@/db/seeds/run-seeds";
import { securityInventoryPermissionsSeed } from "@/db/seeds/inventory-foundation";
import { securitySettlementPermissionsSeed } from "@/db/seeds/settlement-foundation";
import { securityKitchenPermissionsSeed } from "@/db/seeds/kitchen-foundation";
import { securityOrdersPermissionsSeed } from "@/db/seeds/orders-foundation";
import { securityMenuPermissionsSeed } from "@/db/seeds/menu-foundation";
import { securitySchedulingPermissionsSeed } from "@/db/seeds/scheduling-foundation";
import { securityReservationsPermissionsSeed } from "@/db/seeds/reservations-foundation";
import { securityRestaurantPermissionsSeed } from "@/db/seeds/restaurant-foundation";
import { securityHrPermissionsSeed } from "@/db/seeds/security-hr-permissions";
import { securitySystemPermissionsSeed } from "@/db/seeds/security-system-permissions";
import { securityChecksCloseoutPermissionsSeed } from "@/db/seeds/checks-closeout-permissions";
import { securityLaborTipsPermissionsSeed } from "@/db/seeds/labor-tips-permissions";
import { securityMenuStockPermissionsSeed } from "@/db/seeds/menu-stock-permissions";
import { securityServicePolishPermissionsSeed } from "@/db/seeds/service-polish-permissions";
import {
  recipesAllergenFoundationSeed,
  securityGuestProfilesPermissionsSeed,
} from "@/db/seeds/guest-profiles-permissions";
import { PERMISSION_CATALOG } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";

import {
  dropDatabase,
  recreateEmptyDatabase,
} from "../../helpers/prepare-test-database";

const SEED_DATABASE = "restaurant_ops_test_seeds";

describe("foundation seeds, on a fresh database", () => {
  let client: postgres.Sql;
  let database: Database;

  async function totals() {
    const countOf = async (table: PgTable) => {
      const [row] = await database.select({ total: count() }).from(table);

      return row?.total;
    };

    return {
      organizations: await countOf(organizations),
      locations: await countOf(locations),
      locationSettings: await countOf(locationSettings),
      restaurantAreas: await countOf(restaurantAreas),
      roles: await countOf(roles),
      permissions: await countOf(permissions),
      rolePermissions: await countOf(rolePermissions),
      seedRuns: await countOf(seedRuns),
      users: await countOf(users),
      positions: await countOf(positions),
      certificationTypes: await countOf(certificationTypes),
      employees: await countOf(employees),
    };
  }

  const expectedTotals = {
    organizations: 1,
    locations: 1,
    locationSettings: 1,
    restaurantAreas: 3,
    roles: 9,
    permissions: 149,
    rolePermissions: ROLE_CATALOG.reduce(
      (sum, role) => sum + role.permissions.length,
      0,
    ),
    seedRuns: 27,
    users: 0,
    positions: 8,
    certificationTypes: 2,
    employees: 0,
  };

  beforeAll(async () => {
    const url = await recreateEmptyDatabase(
      requireTestDatabaseUrl(),
      SEED_DATABASE,
    );

    await applyMigrations(url);
    client = postgres(url, { max: 2, onnotice: () => {} });
    database = drizzle(client, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await client.end();
    await dropDatabase(requireTestDatabaseUrl(), SEED_DATABASE);
  });

  it("applies once and creates exactly the expected records and no users", async () => {
    const result = await runSeeds(database, seeds);

    expect(result.applied).toEqual([
      "organization.initial",
      "security.initial",
      "security.hr-permissions-v2",
      "employees.reference-data",
      "security.scheduling-permissions",
      "scheduling.default-rules",
      "security.restaurant-permissions",
      "restaurant.initial-floor",
      "security.reservations-permissions",
      "security.menu-permissions",
      "recipes.units-of-measure",
      "menu.initial-configuration",
      "security.inventory-permissions",
      "inventory.packaging-units",
      "inventory.demo-catalog",
      "security.orders-permissions",
      "security.kitchen-permissions",
      "security.settlement-permissions",
      "security.system-permissions",
      "security.checks-closeout-permissions",
      "security.labor-tips-permissions",
      "security.menu-stock-permissions",
      "security.service-polish-permissions",
      "security.guest-profiles-permissions",
      "recipes.allergen-foundation",
      "security.guest-messaging-permissions",
      "security.locations-lots-permissions",
    ]);
    expect(await totals()).toEqual(expectedTotals);
  });

  it("creates no duplicates when run again", async () => {
    const result = await runSeeds(database, seeds);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(27);
    expect(await totals()).toEqual(expectedTotals);
  });

  it("seeds positions and generic certification types, and no employees", async () => {
    const seededPositions = await database
      .select({ code: positions.code })
      .from(positions);
    const seededTypes = await database
      .select({ code: certificationTypes.code })
      .from(certificationTypes);

    expect(seededPositions.map((row) => row.code).sort()).toEqual([
      "BARTENDER",
      "COOK",
      "GENERAL_MANAGER",
      "HOST",
      "INVENTORY_MANAGER",
      "MANAGER",
      "SERVER",
      "WAIT_STAFF",
    ]);
    expect(seededTypes.map((row) => row.code).sort()).toEqual([
      "ALCOHOL_SERVICE",
      "FOOD_SAFETY",
    ]);
  });

  describe("upgrading a Phase 2 database", () => {
    const grantsOf = async (roleCode: string) => {
      const rows = await database
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(roles.code, roleCode));

      return rows.map((row) => row.code).sort();
    };

    it("adds the new permissions and grants, and restores nothing an admin removed", async () => {
      // Back to the Phase 2 catalog: no Phase 3 codes, and the Manager without hr.view.
      const newCodes = PERMISSION_CATALOG.map((row) => row.code).filter(
        (code) =>
          (code.startsWith("hr.") || code.startsWith("employees.")) &&
          !["employees.view", "employees.edit", "hr.view", "hr.compensation.view", "hr.compensation.edit"].includes(code),
      );
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, newCodes));
      const newIds = newRows.map((row) => row.id);

      await database
        .delete(rolePermissions)
        .where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      const [hrView] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "hr.view"));
      const [manager] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "MANAGER"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, manager!.id),
            eq(rolePermissions.permissionId, hrView!.id),
          ),
        );

      // An administrator removed a grant unrelated to Phase 3.
      const [menuEdit] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "menu.edit"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, manager!.id),
            eq(rolePermissions.permissionId, menuEdit!.id),
          ),
        );

      // The Phase 4 codes stay, because this test only rewinds Phase 3.
      expect(await countPermissions()).toBe(129);

      await database.transaction((transaction) =>
        securityHrPermissionsSeed.run(transaction),
      );

      expect(await countPermissions()).toBe(149);

      const expected = ROLE_CATALOG.find((role) => role.code === "MANAGER")!
        .permissions.filter((code) => code !== "menu.edit")
        .sort();

      expect(await grantsOf("MANAGER")).toEqual(expected);
      expect(await grantsOf("OWNER")).toEqual(
        [...PERMISSION_CATALOG.map((row) => row.code)].sort(),
      );

      // Leave the matrix as the other tests in this file expect it.
      await database
        .insert(rolePermissions)
        .values({ roleId: manager!.id, permissionId: menuEdit!.id });
    });

    async function countPermissions() {
      const [row] = await database.select({ total: count() }).from(permissions);

      return row?.total;
    }
  });

  describe("upgrading a Phase 3 database", () => {
    const grantsOf = async (roleCode: string) => {
      const rows = await database
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(roles.code, roleCode));

      return rows.map((row) => row.code).sort();
    };

    it("adds the scheduling grants and restores nothing an admin removed", async () => {
      const newCodes = PERMISSION_CATALOG.map((row) => row.code).filter(
        (code) =>
          code.startsWith("schedule.") &&
          !["schedule.view", "schedule.edit", "schedule.generate", "schedule.publish"].includes(code),
      );
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, newCodes));
      const newIds = newRows.map((row) => row.id);

      await database
        .delete(rolePermissions)
        .where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      const [server] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "SERVER"));
      const [menuView] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "menu.view"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, server!.id),
            eq(rolePermissions.permissionId, menuView!.id),
          ),
        );

      await database.transaction((transaction) =>
        securitySchedulingPermissionsSeed.run(transaction),
      );

      const expected = ROLE_CATALOG.find((role) => role.code === "SERVER")!
        .permissions.filter((code) => code !== "menu.view")
        .sort();

      expect(await grantsOf("SERVER")).toEqual(expected);
      expect(await grantsOf("OWNER")).toEqual(
        [...PERMISSION_CATALOG.map((row) => row.code)].sort(),
      );

      await database
        .insert(rolePermissions)
        .values({ roleId: server!.id, permissionId: menuView!.id });
    });
  });

  describe("upgrading a Phase 4 database", () => {
    it("retires restaurant.manage, adds the granular codes and restores nothing an admin removed", async () => {
      const phase5 = PERMISSION_CATALOG.map((row) => row.code).filter(
        (code) => code.startsWith("restaurant.") && code !== "restaurant.view",
      );
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, phase5));
      const newIds = newRows.map((row) => row.id);

      await database
        .delete(rolePermissions)
        .where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      const [retired] = await database
        .insert(permissions)
        .values({
          code: "restaurant.manage",
          name: "Manage tables and seating",
          category: "Restaurant / Seating",
        })
        .returning({ id: permissions.id });
      const [host] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "HOST"));

      await database
        .insert(rolePermissions)
        .values({ roleId: host!.id, permissionId: retired!.id });

      const [reservationsView] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "reservations.view"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, host!.id),
            eq(rolePermissions.permissionId, reservationsView!.id),
          ),
        );

      await database.transaction((transaction) =>
        securityRestaurantPermissionsSeed.run(transaction),
      );

      const hostGrants = await database
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(rolePermissions.roleId, host!.id));
      const expected = ROLE_CATALOG.find((role) => role.code === "HOST")!
        .permissions.filter((code) => code !== "reservations.view")
        .sort();

      expect(hostGrants.map((row) => row.code).sort()).toEqual(expected);
      expect(
        await database
          .select()
          .from(permissions)
          .where(eq(permissions.code, "restaurant.manage")),
      ).toEqual([]);

      await database
        .insert(rolePermissions)
        .values({ roleId: host!.id, permissionId: reservationsView!.id });
    });
  });

  describe("upgrading a Phase 5 database", () => {
    const PHASE_6 = [
      "reservations.override-hold",
      "waitlist.view",
      "waitlist.manage",
      "waitlist.notify",
      "waitlist.seat",
    ];

    it("adds the reservation and waitlist permissions and restores nothing an admin removed", async () => {
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, PHASE_6));
      const newIds = newRows.map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_6.length);

      await database
        .delete(rolePermissions)
        .where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      // An administrator removed a grant that is not part of Phase 6.
      const [host] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "HOST"));
      const [reservationsManage] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "reservations.manage"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, host!.id),
            eq(rolePermissions.permissionId, reservationsManage!.id),
          ),
        );

      await database.transaction((transaction) =>
        securityReservationsPermissionsSeed.run(transaction),
      );

      const grantsOf = async (roleCode: string) =>
        (
          await database
            .select({ code: permissions.code })
            .from(rolePermissions)
            .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
            .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
            .where(eq(roles.code, roleCode))
        )
          .map((row) => row.code)
          .sort();

      expect(
        await database
          .select()
          .from(permissions)
          .where(inArray(permissions.code, PHASE_6)),
      ).toHaveLength(PHASE_6.length);
      expect(await grantsOf("HOST")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "HOST")!
          .permissions.filter((code) => code !== "reservations.manage")
          .sort(),
      );
      expect(await grantsOf("MANAGER")).toContain("reservations.override-hold");
      expect(await grantsOf("HOST")).not.toContain("reservations.override-hold");
      expect(await grantsOf("SERVER")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "SERVER")!.permissions.slice().sort(),
      );

      // Running it again changes nothing.
      const before = await grantsOf("OWNER");

      await database.transaction((transaction) =>
        securityReservationsPermissionsSeed.run(transaction),
      );
      expect(await grantsOf("OWNER")).toEqual(before);

      await database
        .insert(rolePermissions)
        .values({ roleId: host!.id, permissionId: reservationsManage!.id });
    });
  });

  describe("upgrading a Phase 6 database", () => {
    const PHASE_7 = [
      "menu.pricing.view",
      "menu.pricing.edit",
      "menu.modifiers.manage",
      "prep-stations.manage",
      "recipes.view",
      "recipes.edit",
    ];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(roles.code, roleCode))
      )
        .map((row) => row.code)
        .sort();

    it("adds the menu and recipe permissions and restores nothing an admin removed", async () => {
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, PHASE_7));
      const newIds = newRows.map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_7.length);

      await database
        .delete(rolePermissions)
        .where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      // An administrator removed a grant that is not part of Phase 7.
      const [manager] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "MANAGER"));
      const [menuEdit] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "menu.edit"));

      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, manager!.id),
            eq(rolePermissions.permissionId, menuEdit!.id),
          ),
        );

      await database.transaction((transaction) =>
        securityMenuPermissionsSeed.run(transaction),
      );

      expect(
        await database
          .select()
          .from(permissions)
          .where(inArray(permissions.code, PHASE_7)),
      ).toHaveLength(PHASE_7.length);
      expect(await grantsOf("MANAGER")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "MANAGER")!
          .permissions.filter((code) => code !== "menu.edit")
          .sort(),
      );
      expect(await grantsOf("MANAGER")).toContain("menu.pricing.edit");
      expect(await grantsOf("GENERAL_MANAGER")).toContain("recipes.edit");

      // Floor and kitchen roles can see the menu but never edit prices or recipes.
      for (const code of ["SERVER", "HOST", "COOK", "BARTENDER", "WAIT_STAFF"]) {
        const grants = await grantsOf(code);

        expect(grants.filter((grant) => PHASE_7.includes(grant))).toEqual([]);
      }

      await database
        .insert(rolePermissions)
        .values({ roleId: manager!.id, permissionId: menuEdit!.id });
    });
  });

  describe("upgrading a Phase 7 database", () => {
    const PHASE_8 = [
      "inventory.count.approve",
      "inventory.waste",
      "inventory.transfer",
      "inventory.configure",
      "inventory.cost.view",
      "purchasing.view",
      "purchasing.manage",
      "purchasing.submit",
      "suppliers.manage",
    ];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(roles.code, roleCode))
      )
        .map((row) => row.code)
        .sort();

    it("adds the inventory permissions, grants the Cook stock view, and restores nothing removed", async () => {
      const newRows = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.code, PHASE_8));
      const newIds = newRows.map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_8.length);

      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      const [cook] = await database.select({ id: roles.id }).from(roles).where(eq(roles.code, "COOK"));
      const [manager] = await database.select({ id: roles.id }).from(roles).where(eq(roles.code, "MANAGER"));
      const [inventoryView] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "inventory.view"));
      const [inventoryAdjust] = await database
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.code, "inventory.adjust"));

      // A Phase 7 Cook had no inventory.view; an administrator removed a Manager grant.
      await database
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, cook!.id), eq(rolePermissions.permissionId, inventoryView!.id)));
      await database
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, manager!.id), eq(rolePermissions.permissionId, inventoryAdjust!.id)));

      await database.transaction((transaction) => securityInventoryPermissionsSeed.run(transaction));

      expect(
        await database.select().from(permissions).where(inArray(permissions.code, PHASE_8)),
      ).toHaveLength(PHASE_8.length);
      expect(await grantsOf("COOK")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "COOK")!.permissions.slice().sort(),
      );
      expect(await grantsOf("MANAGER")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "MANAGER")!
          .permissions.filter((code) => code !== "inventory.adjust")
          .sort(),
      );
      expect(await grantsOf("INVENTORY_MANAGER")).toEqual(expect.arrayContaining(PHASE_8));

      for (const code of ["SERVER", "BARTENDER", "HOST", "WAIT_STAFF"]) {
        expect((await grantsOf(code)).filter((grant) => PHASE_8.includes(grant))).toEqual([]);
      }

      expect((await grantsOf("COOK")).filter((grant) => PHASE_8.includes(grant))).toEqual([
        "inventory.waste",
      ]);

      await database
        .insert(rolePermissions)
        .values({ roleId: manager!.id, permissionId: inventoryAdjust!.id });
    });
  });

  describe("upgrading a Phase 8 database", () => {
    const PHASE_9 = ["orders.view", "orders.edit", "orders.discount.apply", "orders.discount.manage"];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(roles.code, roleCode))
      )
        .map((row) => row.code)
        .sort();

    it("adds the order permissions to managers and floor roles, and restores nothing removed", async () => {
      const newRows = await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_9));
      const newIds = newRows.map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_9.length);

      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));

      // An administrator removed a Phase 2 order grant from the Manager.
      const [manager] = await database.select({ id: roles.id }).from(roles).where(eq(roles.code, "MANAGER"));
      const [ordersVoid] = await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, "orders.void"));

      await database
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, manager!.id), eq(rolePermissions.permissionId, ordersVoid!.id)));
      await database.transaction((transaction) => securityOrdersPermissionsSeed.run(transaction));

      expect(await database.select().from(permissions).where(inArray(permissions.code, PHASE_9))).toHaveLength(PHASE_9.length);
      expect(await grantsOf("MANAGER")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "MANAGER")!.permissions.filter((code) => code !== "orders.void").sort(),
      );

      for (const code of ["SERVER", "BARTENDER"]) {
        expect((await grantsOf(code)).filter((grant) => PHASE_9.includes(grant))).toEqual(["orders.edit", "orders.view"]);
      }

      for (const code of ["HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
        expect((await grantsOf(code)).filter((grant) => grant.startsWith("orders."))).toEqual([]);
      }

      await database.insert(rolePermissions).values({ roleId: manager!.id, permissionId: ordersVoid!.id });
    });
  });

  describe("upgrading a Phase 9 database", () => {
    const PHASE_10 = [
      "bar.view",
      "bar.manage",
      "fulfillment.start",
      "fulfillment.ready",
      "fulfillment.complete",
      "fulfillment.remake",
    ];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(roles.code, roleCode))
      )
        .map((row) => row.code)
        .sort();
    const roleId = async (code: string) =>
      (await database.select({ id: roles.id }).from(roles).where(eq(roles.code, code)))[0]!.id;
    const permissionId = async (code: string) =>
      (await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, code)))[0]!.id;

    it("adds the kitchen and bar permissions, moves Bartender to bar scope, and restores nothing removed", async () => {
      const newRows = await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_10));
      const newIds = newRows.map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_10.length);

      // Rewind to Phase 9: no new codes, Bartender holds kitchen.manage, Server has no kitchen.view.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));
      await database
        .insert(rolePermissions)
        .values({ roleId: await roleId("BARTENDER"), permissionId: await permissionId("kitchen.manage") })
        .onConflictDoNothing();
      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, await roleId("SERVER")),
            eq(rolePermissions.permissionId, await permissionId("kitchen.view")),
          ),
        );
      await database
        .update(permissions)
        .set({ name: "View kitchen and bar tickets" })
        .where(eq(permissions.code, "kitchen.view"));

      // An administrator removed the Phase 2 kitchen.manage grant from the Cook.
      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, await roleId("COOK")),
            eq(rolePermissions.permissionId, await permissionId("kitchen.manage")),
          ),
        );
      await database.transaction((transaction) => securityKitchenPermissionsSeed.run(transaction));

      expect(await database.select().from(permissions).where(inArray(permissions.code, PHASE_10))).toHaveLength(
        PHASE_10.length,
      );
      expect(await grantsOf("BARTENDER")).toEqual(
        [...ROLE_CATALOG.find((role) => role.code === "BARTENDER")!.permissions].sort(),
      );
      expect(await grantsOf("SERVER")).toEqual([...ROLE_CATALOG.find((role) => role.code === "SERVER")!.permissions].sort());
      expect(await grantsOf("COOK")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "COOK")!.permissions.filter((code) => code !== "kitchen.manage").sort(),
      );
      expect(
        (await database.select().from(permissions).where(eq(permissions.code, "kitchen.view")))[0]!.name,
      ).toBe("View kitchen station tickets");

      for (const code of ["HOST", "INVENTORY_MANAGER"]) {
        expect((await grantsOf(code)).filter((grant) => PHASE_10.includes(grant))).toEqual([]);
      }

      await database
        .insert(rolePermissions)
        .values({ roleId: await roleId("COOK"), permissionId: await permissionId("kitchen.manage") });
    });
  });

  describe("upgrading a Phase 10 database", () => {
    const PHASE_11 = [
      "settlements.view",
      "settlements.create",
      "settlements.tender.cash",
      "settlements.tender.external-card",
      "settlements.tender.gift-card",
      "settlements.tender.house-account",
      "settlements.tender.other",
      "settlements.void-tender",
      "settlements.view-card-metadata",
    ];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(roles.code, roleCode))
      )
        .map((row) => row.code)
        .sort();
    const roleId = async (code: string) =>
      (await database.select({ id: roles.id }).from(roles).where(eq(roles.code, code)))[0]!.id;
    const permissionId = async (code: string) =>
      (await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, code)))[0]!.id;

    const countPermissions = async () => (await database.select({ total: count() }).from(permissions))[0]?.total;

    it("adds the settlement permissions to managers and floor roles, and restores nothing removed", async () => {
      const newIds = (
        await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_11))
      ).map((row) => row.id);

      expect(newIds).toHaveLength(PHASE_11.length);

      // Rewind to Phase 10, where an administrator had removed settlements.complete from the Server.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, newIds));
      await database.delete(permissions).where(inArray(permissions.id, newIds));
      await database
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, await roleId("SERVER")),
            eq(rolePermissions.permissionId, await permissionId("settlements.complete")),
          ),
        );

      expect(await countPermissions()).toBe(140);

      await database.transaction((transaction) => securitySettlementPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securitySettlementPermissionsSeed.run(transaction));

      expect(await countPermissions()).toBe(149);

      for (const code of ["OWNER", "GENERAL_MANAGER", "MANAGER", "BARTENDER"]) {
        expect(await grantsOf(code)).toEqual([...ROLE_CATALOG.find((role) => role.code === code)!.permissions].sort());
      }

      expect(await grantsOf("SERVER")).toEqual(
        ROLE_CATALOG.find((role) => role.code === "SERVER")!.permissions.filter((code) => code !== "settlements.complete").sort(),
      );

      for (const code of ["HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
        expect((await grantsOf(code)).filter((grant) => grant.startsWith("settlements."))).toEqual([]);
      }

      await database
        .insert(rolePermissions)
        .values({ roleId: await roleId("SERVER"), permissionId: await permissionId("settlements.complete") });
    });
  });

  describe("upgrading a Phase 15 database", () => {
    const PHASE_16 = ["admin.system.view", "admin.system.manage"];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(and(eq(roles.code, roleCode), inArray(permissions.code, PHASE_16)))
      )
        .map((row) => row.code)
        .sort();

    it("adds the System health permissions to the Owner and General Manager only, once", async () => {
      const ids = (
        await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_16))
      ).map((row) => row.id);

      expect(ids).toHaveLength(2);

      // Rewind to Phase 15.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, ids));
      await database.delete(permissions).where(inArray(permissions.id, ids));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 147 }]);

      await database.transaction((transaction) => securitySystemPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securitySystemPermissionsSeed.run(transaction));

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);
      expect(await grantsOf("OWNER")).toEqual([...PHASE_16].sort());
      expect(await grantsOf("GENERAL_MANAGER")).toEqual([...PHASE_16].sort());

      for (const code of ["MANAGER", "SERVER", "BARTENDER", "HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
        expect(await grantsOf(code)).toEqual([]);
      }
    });
  });

  describe("upgrading a Phase 16 database", () => {
    const PHASE_17 = [
      "tax.view",
      "tax.manage",
      "orders.move-items",
      "orders.fire",
      "settlements.refund",
      "settlements.refund-void",
      "drawers.view",
      "drawers.operate",
      "drawers.manage",
    ];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(and(eq(roles.code, roleCode), inArray(permissions.code, PHASE_17)))
      )
        .map((row) => row.code)
        .sort();

    it("adds the Phase 17 permissions with the catalog's grants, once", async () => {
      const ids = (
        await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_17))
      ).map((row) => row.id);

      expect(ids).toHaveLength(9);

      // Rewind to Phase 16.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, ids));
      await database.delete(permissions).where(inArray(permissions.id, ids));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 140 }]);

      await database.transaction((transaction) => securityChecksCloseoutPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securityChecksCloseoutPermissionsSeed.run(transaction));

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      for (const role of ROLE_CATALOG) {
        expect(await grantsOf(role.code)).toEqual(role.permissions.filter((code) => PHASE_17.includes(code)).sort());
      }

      expect(await grantsOf("SERVER")).toEqual(["drawers.view", "orders.fire", "orders.move-items"]);
      expect(await grantsOf("HOST")).toEqual([]);
    });
  });

  describe("upgrading a Phase 17 database", () => {
    const PHASE_18 = ["timeclock.punch", "timeclock.view", "timeclock.manage", "tips.manage", "reports.tips"];

    const grantsOf = async (roleCode: string) =>
      (
        await database
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(and(eq(roles.code, roleCode), inArray(permissions.code, PHASE_18)))
      )
        .map((row) => row.code)
        .sort();

    it("adds the Phase 18 permissions with the catalog's grants, once", async () => {
      const ids = (
        await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, PHASE_18))
      ).map((row) => row.id);

      expect(ids).toHaveLength(5);

      // Rewind to Phase 17.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, ids));
      await database.delete(permissions).where(inArray(permissions.id, ids));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 144 }]);

      await database.transaction((transaction) => securityLaborTipsPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securityLaborTipsPermissionsSeed.run(transaction));

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      for (const role of ROLE_CATALOG) {
        expect(await grantsOf(role.code)).toEqual(role.permissions.filter((code) => PHASE_18.includes(code)).sort());
      }

      // Every role punches; only Owner, General Manager and Manager oversee time and tips.
      for (const code of ["SERVER", "BARTENDER", "HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
        expect(await grantsOf(code)).toEqual(["timeclock.punch"]);
      }

      for (const code of ["OWNER", "GENERAL_MANAGER", "MANAGER"]) {
        expect(await grantsOf(code)).toEqual([...PHASE_18].sort());
      }
    });
  });

  describe("upgrading a Phase 18 database", () => {
    it("adds menu.availability.manage with the catalog's grants, once", async () => {
      const [code] = await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, "menu.availability.manage"));

      // Rewind to Phase 18.
      await database.delete(rolePermissions).where(eq(rolePermissions.permissionId, code!.id));
      await database.delete(permissions).where(eq(permissions.id, code!.id));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 148 }]);

      await database.transaction((transaction) => securityMenuStockPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securityMenuStockPermissionsSeed.run(transaction));

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      const holders = (
        await database
          .select({ role: roles.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(permissions.code, "menu.availability.manage"))
      )
        .map((row) => row.role)
        .sort();

      expect(holders).toEqual(["BARTENDER", "COOK", "GENERAL_MANAGER", "MANAGER", "OWNER"]);
    });
  });

  describe("upgrading a Phase 19 database", () => {
    it("adds tax.exempt for Owner, General Manager and Manager, once", async () => {
      const [code] = await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, "tax.exempt"));

      // Rewind to Phase 19.
      await database.delete(rolePermissions).where(eq(rolePermissions.permissionId, code!.id));
      await database.delete(permissions).where(eq(permissions.id, code!.id));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 148 }]);

      await database.transaction((transaction) => securityServicePolishPermissionsSeed.run(transaction));
      await database.transaction((transaction) => securityServicePolishPermissionsSeed.run(transaction));

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      const holders = (
        await database
          .select({ role: roles.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(permissions.code, "tax.exempt"))
      )
        .map((row) => row.role)
        .sort();

      expect(holders).toEqual(["GENERAL_MANAGER", "MANAGER", "OWNER"]);
    });
  });

  describe("upgrading a Phase 21 database", () => {
    it("adds the online booking and guest message permissions with the catalog's grants, once", async () => {
      const codes = ["reservations.online.manage", "messages.view", "messages.resend"];
      const rows = await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, codes));

      // Rewind to Phase 21.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, rows.map((row) => row.id)));
      await database.delete(permissions).where(inArray(permissions.id, rows.map((row) => row.id)));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 146 }]);

      for (let run = 0; run < 2; run += 1) {
        await database.transaction((transaction) => securityGuestMessagingPermissionsSeed.run(transaction));
      }

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      const holders = async (code: string) =>
        (
          await database
            .select({ role: roles.code })
            .from(rolePermissions)
            .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
            .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
            .where(eq(permissions.code, code))
        )
          .map((row) => row.role)
          .sort();

      expect(await holders("reservations.online.manage")).toEqual(["GENERAL_MANAGER", "MANAGER", "OWNER"]);
      expect(await holders("messages.view")).toEqual(["GENERAL_MANAGER", "HOST", "MANAGER", "OWNER"]);
      expect(await holders("messages.resend")).toEqual(["GENERAL_MANAGER", "HOST", "MANAGER", "OWNER"]);
    });
  });

  describe("upgrading a Phase 22 database", () => {
    it("adds the location lifecycle permission to Owner and General Manager, once", async () => {
      const [row] = await database.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, "locations.lifecycle"));

      // Rewind to Phase 22.
      await database.delete(rolePermissions).where(eq(rolePermissions.permissionId, row!.id));
      await database.delete(permissions).where(eq(permissions.id, row!.id));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 148 }]);

      for (let run = 0; run < 2; run += 1) {
        await database.transaction((transaction) => securityLocationsLotsPermissionsSeed.run(transaction));
      }

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);

      const holders = (
        await database
          .select({ role: roles.code })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(permissions.code, "locations.lifecycle"))
      )
        .map((row) => row.role)
        .sort();

      expect(holders).toEqual(["GENERAL_MANAGER", "OWNER"]);
    });
  });

  describe("upgrading a Phase 20 database", () => {
    it("adds the guest and allergen permissions with the catalog's grants, and the allergen list, once", async () => {
      const codes = [
        "guests.view",
        "guests.contact.view",
        "guests.manage",
        "guests.merge",
        "guests.erase",
        "recipes.allergens.manage",
      ];
      const rows = await database.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, codes));

      // Rewind to Phase 20.
      await database.delete(rolePermissions).where(inArray(rolePermissions.permissionId, rows.map((row) => row.id)));
      await database.delete(permissions).where(inArray(permissions.id, rows.map((row) => row.id)));
      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 143 }]);

      for (let run = 0; run < 2; run += 1) {
        await database.transaction((transaction) => securityGuestProfilesPermissionsSeed.run(transaction));
        await database.transaction((transaction) => recipesAllergenFoundationSeed.run(transaction));
      }

      expect(await database.select({ total: count() }).from(permissions)).toEqual([{ total: 149 }]);
      expect(await database.select({ total: count() }).from(schema.allergens)).toEqual([{ total: 9 }]);

      const holders = async (code: string) =>
        (
          await database
            .select({ role: roles.code })
            .from(rolePermissions)
            .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
            .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
            .where(eq(permissions.code, code))
        )
          .map((row) => row.role)
          .sort();

      expect(await holders("guests.erase")).toEqual(["GENERAL_MANAGER", "OWNER"]);
      expect(await holders("guests.contact.view")).toEqual(["GENERAL_MANAGER", "HOST", "MANAGER", "OWNER"]);
      expect(await holders("recipes.allergens.manage")).toEqual(["GENERAL_MANAGER", "INVENTORY_MANAGER", "MANAGER", "OWNER"]);
    });
  });

  it("seeds no settlements, tenders or settlement history", async () => {
    expect(await database.select().from(schema.settlements)).toEqual([]);
    expect(await database.select().from(schema.settlementTenders)).toEqual([]);
    expect(await database.select().from(schema.settlementStatusHistory)).toEqual([]);
  });

  it("seeds no kitchen tickets, notifications or outbox events", async () => {
    expect(await database.select().from(schema.kitchenTickets)).toEqual([]);
    expect(await database.select().from(schema.kitchenTicketItems)).toEqual([]);
    expect(await database.select().from(schema.notifications)).toEqual([]);
    expect(await database.select().from(schema.outboxEvents)).toEqual([]);
  });

  it("seeds no orders, discounts or idempotency records", async () => {
    expect(await database.select().from(schema.orders)).toEqual([]);
    expect(await database.select().from(schema.discountDefinitions)).toEqual([]);
    expect(await database.select().from(schema.idempotencyRecords)).toEqual([]);
  });

  it("seeds a demo inventory catalog with no stock and no ledger rows", async () => {
    const items = await database.select().from(schema.inventoryItems);
    const itemLocations = await database.select().from(schema.inventoryItemLocations);
    const supplierRows = await database.select().from(schema.suppliers);
    const supplierItemRows = await database
      .select({
        code: schema.inventoryItems.code,
        baseUnitsPerPurchase: schema.supplierItems.baseUnitsPerPurchase,
      })
      .from(schema.supplierItems)
      .innerJoin(schema.inventoryItems, eq(schema.inventoryItems.id, schema.supplierItems.inventoryItemId));

    expect(items.map((item) => item.code).sort()).toEqual([
      "AMERICAN_CHEESE",
      "BACON",
      "BRIOCHE_BUN",
      "GROUND_BEEF",
      "LIME_JUICE",
      "TITOS_VODKA",
    ]);
    expect(itemLocations).toHaveLength(6);
    expect(supplierRows.map((supplier) => supplier.code)).toEqual(["DEMO_FOODS"]);
    expect(Object.fromEntries(supplierItemRows.map((row) => [row.code, row.baseUnitsPerPurchase]))).toEqual({
      AMERICAN_CHEESE: "120.0000",
      BACON: "300.0000",
      BRIOCHE_BUN: "12.0000",
      GROUND_BEEF: "16.0000",
      LIME_JUICE: "32.0000",
      TITOS_VODKA: "12000.0000",
    });
    expect(await database.select().from(schema.inventoryTransactions)).toEqual([]);
    expect(await database.select().from(schema.inventoryBalances)).toEqual([]);
    expect(await database.select().from(schema.purchaseOrders)).toEqual([]);
  });

  it("seeds units, conversions, categories, stations and an empty Main Menu", async () => {
    const units = await database.select().from(schema.unitsOfMeasure);
    const conversions = await database.select().from(schema.unitConversions);
    const categories = await database.select().from(schema.menuCategories);
    const stations = await database.select().from(schema.prepStations);
    const menuRows = await database.select().from(schema.menus);
    const menuLocationRows = await database.select().from(schema.menuLocations);

    expect(units.map((unit) => unit.code).sort()).toEqual([
      "BAG",
      "BOTTLE",
      "BOX",
      "CAN",
      "CASE",
      "EACH",
      "FL_OZ",
      "G",
      "KG",
      "L",
      "LB",
      "ML",
      "OZ_WEIGHT",
      "PACK",
      "SLICE",
    ]);
    expect(conversions).toHaveLength(6);
    expect(categories.map((category) => category.code).sort()).toEqual([
      "APPETIZERS",
      "BEER",
      "BURGERS",
      "COCKTAILS",
      "ENTREES",
      "NON_ALCOHOLIC",
      "SALADS",
    ]);
    expect(stations.map((station) => station.code).sort()).toEqual([
      "BAR",
      "EXPO",
      "FRY",
      "GRILL",
      "SALAD",
    ]);
    expect(menuRows.map((menu) => menu.code)).toEqual(["MAIN"]);
    expect(menuLocationRows).toHaveLength(1);
    expect(await database.select().from(schema.menuItems)).toEqual([]);
    expect(await database.select().from(schema.menuItemPrices)).toEqual([]);
    expect(await database.select().from(schema.recipes)).toEqual([]);
  });

  it("seeds the floor at MAIN, with no Takeout table and no sessions", async () => {
    const tables = await database
      .select({
        tableNumber: schema.restaurantTables.tableNumber,
        capacity: schema.restaurantTables.capacity,
        areaCode: restaurantAreas.code,
      })
      .from(schema.restaurantTables)
      .innerJoin(
        restaurantAreas,
        eq(restaurantAreas.id, schema.restaurantTables.restaurantAreaId),
      )
      .orderBy(schema.restaurantTables.tableNumber);

    expect(tables).toEqual([
      { tableNumber: "B01", capacity: 2, areaCode: "BAR" },
      { tableNumber: "B02", capacity: 2, areaCode: "BAR" },
      { tableNumber: "T01", capacity: 4, areaCode: "DINING_ROOM" },
      { tableNumber: "T02", capacity: 4, areaCode: "DINING_ROOM" },
      { tableNumber: "T03", capacity: 2, areaCode: "DINING_ROOM" },
      { tableNumber: "T04", capacity: 6, areaCode: "DINING_ROOM" },
    ]);

    const sections = await database.select().from(schema.serverSections);
    const memberships = await database.select().from(schema.serverSectionTables);

    expect(sections.map((section) => section.code).sort()).toEqual([
      "BAR",
      "DINING_A",
    ]);
    expect(memberships).toHaveLength(6);
    expect(await database.select().from(schema.tableConditionHistory)).toHaveLength(6);
    expect(await database.select().from(schema.tableSessions)).toEqual([]);
    expect(await database.select().from(schema.serverSectionAssignments)).toEqual([]);
    expect(await database.select().from(schema.guestParties)).toEqual([]);
    expect(await database.select().from(schema.reservations)).toEqual([]);
    expect(await database.select().from(schema.waitlistEntries)).toEqual([]);
  });

  it("seeds default rules, and no staffing demand or employee records", async () => {
    const rules = await database.select().from(schedulingRules);

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      avoidOvertime: true,
      weeklyOvertimeThreshold: "40.00",
      minimumRestHours: "8.00",
      minimumRestHard: false,
      maximumDaysPerWeek: null,
      weekStartDay: 1,
    });
    expect(await database.select().from(schema.staffingTemplates)).toEqual([]);
    expect(await database.select().from(schema.schedulePeriods)).toEqual([]);
    expect(await database.select().from(schema.employeeAvailability)).toEqual([]);
  });

  it("seeds the organization and location values", async () => {
    const [organization] = await database.select().from(organizations);
    const [location] = await database.select().from(locations);

    expect(organization).toMatchObject({
      name: "Restaurant Operations POC",
      defaultTimezone: "America/Detroit",
      defaultCurrency: "USD",
      active: true,
    });
    expect(location).toMatchObject({
      organizationId: organization?.id,
      name: "Main Restaurant",
      locationCode: "MAIN",
      timezone: "America/Detroit",
      addressLine1: null,
      active: true,
    });
  });

  it("seeds exactly Dining Room, Bar and Takeout", async () => {
    const areas = await database.select().from(restaurantAreas);

    expect(
      areas.map((area) => [area.code, area.name]).sort(),
    ).toEqual([
      ["BAR", "Bar"],
      ["DINING_ROOM", "Dining Room"],
      ["TAKEOUT", "Takeout"],
    ]);
  });

  it("seeds the catalog and matrix exactly as defined in source", async () => {
    const seededCodes = await database
      .select({ code: permissions.code })
      .from(permissions);

    expect(seededCodes.map((row) => row.code).sort()).toEqual(
      PERMISSION_CATALOG.map((permission) => permission.code).sort(),
    );

    for (const definition of ROLE_CATALOG) {
      const rows = await database
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(roles.code, definition.code));

      expect(rows.map((row) => row.code).sort(), definition.code).toEqual(
        [...definition.permissions].sort(),
      );
    }
  });

  it("marks every seeded role as a system role", async () => {
    const rows = await database.select().from(roles);

    expect(rows.every((role) => role.systemRole && role.active)).toBe(true);
  });
});
