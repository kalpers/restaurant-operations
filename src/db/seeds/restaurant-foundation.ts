import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import {
  locations,
  permissions,
  restaurantAreas,
  restaurantTables,
  rolePermissions,
  roles,
  serverSections,
  serverSectionTables,
  tableConditionHistory,
} from "../schema";
import type { Seed } from "./run-seeds";

const RETIRED_CODE = "restaurant.manage";

/** Codes Phase 5 added. `restaurant.view` is older and unchanged. */
const PHASE_5_CODES: readonly PermissionCode[] = PERMISSION_CATALOG.map(
  (permission) => permission.code,
).filter((code) => code.startsWith("restaurant.") && code !== "restaurant.view");

/**
 * Upgrades a Phase 4 database, and on a fresh one finds nothing to do. `restaurant.manage`
 * was never enforced anywhere, so it's retired rather than kept beside the granular codes.
 * Only Phase 5 codes are granted, on system roles, so a grant an administrator removed
 * from any other permission stays removed.
 */
export const securityRestaurantPermissionsSeed: Seed = {
  key: "security.restaurant-permissions",
  run: async (transaction) => {
    const retired = await transaction
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.code, RETIRED_CODE));

    for (const { id } of retired) {
      await transaction
        .delete(rolePermissions)
        .where(eq(rolePermissions.permissionId, id));
      await transaction.delete(permissions).where(eq(permissions.id, id));
    }

    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) =>
          PHASE_5_CODES.includes(permission.code),
        ).map((permission) => ({ ...permission })),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_5_CODES]));
    const permissionIds = new Map(
      permissionRows.map((row) => [row.code, row.id]),
    );

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions.flatMap((code) => {
        const permissionId = permissionIds.get(code);

        return permissionId ? [permissionId] : [];
      });

      if (grants.length === 0) {
        continue;
      }

      const roleRows = await transaction
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, definition.code), eq(roles.systemRole, true)));

      for (const role of roleRows) {
        await transaction
          .insert(rolePermissions)
          .values(
            grants.map((permissionId) => ({ roleId: role.id, permissionId })),
          )
          .onConflictDoNothing();
      }
    }
  },
};

const FLOOR = [
  { areaCode: "DINING_ROOM", tableNumber: "T01", capacity: 4, sortOrder: 10 },
  { areaCode: "DINING_ROOM", tableNumber: "T02", capacity: 4, sortOrder: 20 },
  { areaCode: "DINING_ROOM", tableNumber: "T03", capacity: 2, sortOrder: 30 },
  { areaCode: "DINING_ROOM", tableNumber: "T04", capacity: 6, sortOrder: 40 },
  { areaCode: "BAR", tableNumber: "B01", capacity: 2, sortOrder: 10 },
  { areaCode: "BAR", tableNumber: "B02", capacity: 2, sortOrder: 20 },
] as const;

const SECTIONS = [
  { code: "DINING_A", name: "Dining A", areaCode: "DINING_ROOM" },
  { code: "BAR", name: "Bar", areaCode: "BAR" },
] as const;

/**
 * A modest development floor at MAIN, identified by stable table numbers and section
 * codes. There are no sessions and no Takeout table. Nothing is written for a location
 * that isn't MAIN, and an existing table or section is left as it is.
 */
export const restaurantInitialFloorSeed: Seed = {
  key: "restaurant.initial-floor",
  run: async (transaction) => {
    const [location] = await transaction
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.locationCode, "MAIN"));

    if (!location) {
      return;
    }

    const areas = await transaction
      .select({ id: restaurantAreas.id, code: restaurantAreas.code })
      .from(restaurantAreas)
      .where(eq(restaurantAreas.locationId, location.id));
    const areaIds = new Map(areas.map((area) => [area.code, area.id]));

    for (const { areaCode, ...table } of FLOOR) {
      const restaurantAreaId = areaIds.get(areaCode);

      if (!restaurantAreaId) {
        continue;
      }

      const inserted = await transaction
        .insert(restaurantTables)
        .values({ ...table, locationId: location.id, restaurantAreaId })
        .onConflictDoNothing()
        .returning({ id: restaurantTables.id });

      if (inserted[0]) {
        await transaction.insert(tableConditionHistory).values({
          restaurantTableId: inserted[0].id,
          condition: "CLEAN",
          reason: "Table created",
        });
      }
    }

    for (const { areaCode, ...section } of SECTIONS) {
      const restaurantAreaId = areaIds.get(areaCode);

      if (!restaurantAreaId) {
        continue;
      }

      const [created] = await transaction
        .insert(serverSections)
        .values({ ...section, locationId: location.id, restaurantAreaId })
        .onConflictDoNothing()
        .returning({ id: serverSections.id });

      if (created) {
        const tables = await transaction
          .select({ id: restaurantTables.id })
          .from(restaurantTables)
          .where(eq(restaurantTables.restaurantAreaId, restaurantAreaId));

        if (tables.length > 0) {
          await transaction
            .insert(serverSectionTables)
            .values(
              tables.map((table) => ({
                serverSectionId: created.id,
                locationId: location.id,
                restaurantTableId: table.id,
              })),
            )
            .onConflictDoNothing();
        }
      }
    }
  },
};
