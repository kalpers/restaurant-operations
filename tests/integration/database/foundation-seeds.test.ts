import { count, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import type { Database } from "@/db";
import { applyMigrations } from "@/db/maintenance/apply-migrations";
import * as schema from "@/db/schema";
import {
  locations,
  locationSettings,
  organizations,
  permissions,
  rolePermissions,
  roles,
  restaurantAreas,
  seedRuns,
  users,
} from "@/db/schema";
import { seeds } from "@/db/seeds/registry";
import { runSeeds } from "@/db/seeds/run-seeds";
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
    };
  }

  const expectedTotals = {
    organizations: 1,
    locations: 1,
    locationSettings: 1,
    restaurantAreas: 3,
    roles: 9,
    permissions: 44,
    rolePermissions: ROLE_CATALOG.reduce(
      (sum, role) => sum + role.permissions.length,
      0,
    ),
    seedRuns: 2,
    users: 0,
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

    expect(result.applied).toEqual(["organization.initial", "security.initial"]);
    expect(await totals()).toEqual(expectedTotals);
  });

  it("creates no duplicates when run again", async () => {
    const result = await runSeeds(database, seeds);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(await totals()).toEqual(expectedTotals);
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
