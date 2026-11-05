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
import { seeds } from "@/db/seeds/registry";
import { runSeeds } from "@/db/seeds/run-seeds";
import { securitySchedulingPermissionsSeed } from "@/db/seeds/scheduling-foundation";
import { securityHrPermissionsSeed } from "@/db/seeds/security-hr-permissions";
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
    permissions: 72,
    rolePermissions: ROLE_CATALOG.reduce(
      (sum, role) => sum + role.permissions.length,
      0,
    ),
    seedRuns: 6,
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
    ]);
    expect(await totals()).toEqual(expectedTotals);
  });

  it("creates no duplicates when run again", async () => {
    const result = await runSeeds(database, seeds);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(6);
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
      expect(await countPermissions()).toBe(52);

      await database.transaction((transaction) =>
        securityHrPermissionsSeed.run(transaction),
      );

      expect(await countPermissions()).toBe(72);

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
