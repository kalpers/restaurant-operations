import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import {
  locations,
  menuCategories,
  menuLocations,
  menus,
  permissions,
  prepStations,
  rolePermissions,
  roles,
  unitConversions,
  unitsOfMeasure,
} from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 7 added. `menu.view` and `menu.edit` are older and unchanged. */
const PHASE_7_CODES: readonly PermissionCode[] = [
  "menu.pricing.view",
  "menu.pricing.edit",
  "menu.modifiers.manage",
  "prep-stations.manage",
  "recipes.view",
  "recipes.edit",
];

/**
 * Upgrades a Phase 6 database, and on a fresh one finds the grants already in place.
 * Only Phase 7 codes are granted, on system roles, so a grant an administrator removed
 * from any other permission stays removed.
 */
export const securityMenuPermissionsSeed: Seed = {
  key: "security.menu-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) =>
          PHASE_7_CODES.includes(permission.code),
        ).map((permission) => ({ ...permission })),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_7_CODES]));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

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
          .values(grants.map((permissionId) => ({ roleId: role.id, permissionId })))
          .onConflictDoNothing();
      }
    }
  },
};

const UNITS = [
  { code: "EACH", name: "Each", measurementType: "COUNT" },
  { code: "OZ_WEIGHT", name: "Ounce (weight)", measurementType: "WEIGHT" },
  { code: "LB", name: "Pound", measurementType: "WEIGHT" },
  { code: "G", name: "Gram", measurementType: "WEIGHT" },
  { code: "KG", name: "Kilogram", measurementType: "WEIGHT" },
  { code: "FL_OZ", name: "Fluid ounce", measurementType: "VOLUME" },
  { code: "ML", name: "Milliliter", measurementType: "VOLUME" },
  { code: "L", name: "Liter", measurementType: "VOLUME" },
] as const;

// Only exact, approved factors. Pound/gram and fluid ounce/milliliter are not approved here.
const CONVERSIONS = [
  { from: "LB", to: "OZ_WEIGHT", factor: "16.000000" },
  { from: "OZ_WEIGHT", to: "LB", factor: "0.062500" },
  { from: "G", to: "KG", factor: "0.001000" },
  { from: "KG", to: "G", factor: "1000.000000" },
  { from: "ML", to: "L", factor: "0.001000" },
  { from: "L", to: "ML", factor: "1000.000000" },
] as const;

/** The unit vocabulary and its explicit conversions. Never an ambiguous "OZ". */
export const unitsOfMeasureSeed: Seed = {
  key: "recipes.units-of-measure",
  run: async (transaction) => {
    await transaction
      .insert(unitsOfMeasure)
      .values(UNITS.map((unit) => ({ ...unit })))
      .onConflictDoNothing({ target: unitsOfMeasure.code });

    const rows = await transaction
      .select({
        id: unitsOfMeasure.id,
        code: unitsOfMeasure.code,
        type: unitsOfMeasure.measurementType,
      })
      .from(unitsOfMeasure);
    const byCode = new Map(rows.map((row) => [row.code, row]));

    await transaction
      .insert(unitConversions)
      .values(
        CONVERSIONS.map((conversion) => {
          const from = byCode.get(conversion.from)!;
          const to = byCode.get(conversion.to)!;

          return {
            fromUnitId: from.id,
            toUnitId: to.id,
            measurementType: from.type,
            factor: conversion.factor,
          };
        }),
      )
      .onConflictDoNothing({
        target: [unitConversions.fromUnitId, unitConversions.toUnitId],
      });
  },
};

const CATEGORIES = [
  { code: "APPETIZERS", name: "Appetizers", displayOrder: 10 },
  { code: "ENTREES", name: "Entrees", displayOrder: 20 },
  { code: "BURGERS", name: "Burgers", displayOrder: 30 },
  { code: "SALADS", name: "Salads", displayOrder: 40 },
  { code: "BEER", name: "Beer", displayOrder: 50 },
  { code: "COCKTAILS", name: "Cocktails", displayOrder: 60 },
  { code: "NON_ALCOHOLIC", name: "Non-Alcoholic", displayOrder: 70 },
] as const;

const STATIONS = [
  { code: "GRILL", name: "Grill", stationType: "KITCHEN", sortOrder: 10 },
  { code: "FRY", name: "Fry", stationType: "KITCHEN", sortOrder: 20 },
  { code: "SALAD", name: "Salad", stationType: "KITCHEN", sortOrder: 30 },
  { code: "BAR", name: "Bar", stationType: "BAR", sortOrder: 40 },
  { code: "EXPO", name: "Expo", stationType: "EXPO", sortOrder: 50 },
] as const;

/**
 * Configuration only: categories, prep stations and an empty Main Menu offered at MAIN.
 * There are no menu items, prices, modifiers or recipes. Nothing is written for a
 * location that isn't MAIN, and existing records are left as they are.
 */
export const menuInitialConfigurationSeed: Seed = {
  key: "menu.initial-configuration",
  run: async (transaction) => {
    const [location] = await transaction
      .select({ id: locations.id, organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.locationCode, "MAIN"));

    if (!location) {
      return;
    }

    await transaction
      .insert(menuCategories)
      .values(
        CATEGORIES.map((category) => ({
          ...category,
          organizationId: location.organizationId,
        })),
      )
      .onConflictDoNothing();

    await transaction
      .insert(prepStations)
      .values(STATIONS.map((station) => ({ ...station, locationId: location.id })))
      .onConflictDoNothing();

    await transaction
      .insert(menus)
      .values({
        organizationId: location.organizationId,
        code: "MAIN",
        name: "Main Menu",
        displayOrder: 10,
      })
      .onConflictDoNothing();

    const [menu] = await transaction
      .select({ id: menus.id })
      .from(menus)
      .where(
        and(eq(menus.organizationId, location.organizationId), eq(menus.code, "MAIN")),
      );

    if (menu) {
      await transaction
        .insert(menuLocations)
        .values({
          organizationId: location.organizationId,
          menuId: menu.id,
          locationId: location.id,
        })
        .onConflictDoNothing();
    }
  },
};
