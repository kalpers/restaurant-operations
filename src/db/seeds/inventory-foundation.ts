import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { toBaseQuantity } from "../../modules/inventory/rules/unit-resolution";
import {
  inventoryItemLocations,
  inventoryItems,
  inventoryItemUnitConversions,
  locations,
  permissions,
  rolePermissions,
  roles,
  supplierItems,
  suppliers,
  unitConversions,
  unitsOfMeasure,
} from "../schema";
import type { DatabaseTransaction } from "../transactions/transaction-context";
import type { Seed } from "./run-seeds";

/** Codes Phase 8 added. `inventory.view`, `.receive`, `.adjust` and `.count` are older. */
const PHASE_8_CODES: readonly PermissionCode[] = [
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

/** Older codes Phase 8 newly grants, deliberately: a Cook now sees stock to record waste. */
const PHASE_8_REGRANTS: readonly { roleCode: string; code: PermissionCode }[] = [
  { roleCode: "COOK", code: "inventory.view" },
];

/**
 * Upgrades a Phase 7 database, and on a fresh one finds the grants already in place. Only
 * Phase 8 codes and the listed regrants are granted, on system roles, so a grant an
 * administrator removed from any other permission stays removed.
 */
export const securityInventoryPermissionsSeed: Seed = {
  key: "security.inventory-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_8_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    const codes = [...PHASE_8_CODES, ...PHASE_8_REGRANTS.map((entry) => entry.code)];
    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, codes));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const wanted = [
        ...definition.permissions.filter((code) => PHASE_8_CODES.includes(code)),
        ...PHASE_8_REGRANTS.filter(
          (entry) =>
            entry.roleCode === definition.code && definition.permissions.includes(entry.code),
        ).map((entry) => entry.code),
      ];
      const grants = wanted.flatMap((code) => {
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

const PACKAGING_UNITS = [
  { code: "CASE", name: "Case" },
  { code: "BOTTLE", name: "Bottle" },
  { code: "CAN", name: "Can" },
  { code: "BAG", name: "Bag" },
  { code: "BOX", name: "Box" },
  { code: "PACK", name: "Pack" },
  { code: "SLICE", name: "Slice" },
] as const;

/** Packaging units are COUNT units. What a case holds is per item, never generic. */
export const packagingUnitsSeed: Seed = {
  key: "inventory.packaging-units",
  run: async (transaction) => {
    await transaction
      .insert(unitsOfMeasure)
      .values(PACKAGING_UNITS.map((unit) => ({ ...unit, measurementType: "COUNT" })))
      .onConflictDoNothing({ target: unitsOfMeasure.code });
  },
};

type DemoItem = {
  code: string;
  name: string;
  measurementType: "COUNT" | "WEIGHT" | "VOLUME";
  baseUnit: string;
  conversions: { from: string; to: string; factor: string }[];
  levels: { par: string; reorder: string; target: string };
};

const DEMO_ITEMS: readonly DemoItem[] = [
  {
    code: "GROUND_BEEF",
    name: "Ground beef",
    measurementType: "WEIGHT",
    baseUnit: "OZ_WEIGHT",
    conversions: [],
    levels: { par: "640.0000", reorder: "320.0000", target: "640.0000" },
  },
  {
    code: "BRIOCHE_BUN",
    name: "Brioche bun",
    measurementType: "COUNT",
    baseUnit: "EACH",
    conversions: [{ from: "PACK", to: "EACH", factor: "12.000000" }],
    levels: { par: "96.0000", reorder: "48.0000", target: "96.0000" },
  },
  {
    code: "AMERICAN_CHEESE",
    name: "American cheese",
    measurementType: "COUNT",
    baseUnit: "SLICE",
    conversions: [{ from: "PACK", to: "SLICE", factor: "120.000000" }],
    levels: { par: "240.0000", reorder: "120.0000", target: "240.0000" },
  },
  {
    code: "BACON",
    name: "Bacon",
    measurementType: "COUNT",
    baseUnit: "SLICE",
    conversions: [{ from: "CASE", to: "SLICE", factor: "300.000000" }],
    levels: { par: "300.0000", reorder: "100.0000", target: "300.0000" },
  },
  {
    code: "TITOS_VODKA",
    name: "Tito's vodka",
    measurementType: "VOLUME",
    baseUnit: "ML",
    conversions: [
      { from: "CASE", to: "BOTTLE", factor: "12.000000" },
      { from: "BOTTLE", to: "L", factor: "1.000000" },
    ],
    levels: { par: "12000.0000", reorder: "4000.0000", target: "12000.0000" },
  },
  {
    code: "LIME_JUICE",
    name: "Lime juice",
    measurementType: "VOLUME",
    baseUnit: "FL_OZ",
    conversions: [{ from: "BOTTLE", to: "FL_OZ", factor: "32.000000" }],
    levels: { par: "128.0000", reorder: "64.0000", target: "128.0000" },
  },
];

const DEMO_SUPPLIER_ITEMS = [
  { item: "GROUND_BEEF", unit: "LB", sku: "BEEF-8020" },
  { item: "BRIOCHE_BUN", unit: "PACK", sku: "BUN-12" },
  { item: "AMERICAN_CHEESE", unit: "PACK", sku: "CHZ-AM-120" },
  { item: "BACON", unit: "CASE", sku: "BAC-300" },
  { item: "TITOS_VODKA", unit: "CASE", sku: "TITO-1L-12" },
  { item: "LIME_JUICE", unit: "BOTTLE", sku: "LIME-32" },
] as const;

async function unitIds(transaction: DatabaseTransaction) {
  const rows = await transaction
    .select({ id: unitsOfMeasure.id, code: unitsOfMeasure.code })
    .from(unitsOfMeasure);

  return new Map(rows.map((row) => [row.code, row.id]));
}

/**
 * A modest demo catalog for the organization that owns MAIN: six items with MAIN levels and
 * packaging, and one supplier selling each. Configuration only: no stock, no ledger rows,
 * no purchase orders. Existing rows are left as they are.
 */
export const inventoryDemoCatalogSeed: Seed = {
  key: "inventory.demo-catalog",
  run: async (transaction) => {
    const [location] = await transaction
      .select({ id: locations.id, organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.locationCode, "MAIN"));

    if (!location) {
      return;
    }

    const organizationId = location.organizationId;
    const units = await unitIds(transaction);
    const unit = (code: string) => {
      const id = units.get(code);

      if (!id) {
        throw new Error(`Seed unit ${code} is missing.`);
      }

      return id;
    };

    for (const item of DEMO_ITEMS) {
      await transaction
        .insert(inventoryItems)
        .values({
          organizationId,
          code: item.code,
          name: item.name,
          measurementType: item.measurementType,
          baseUnitId: unit(item.baseUnit),
        })
        .onConflictDoNothing();
    }

    const itemRows = await transaction
      .select({ id: inventoryItems.id, code: inventoryItems.code, baseUnitId: inventoryItems.baseUnitId })
      .from(inventoryItems)
      .where(eq(inventoryItems.organizationId, organizationId));
    const byCode = new Map(itemRows.map((row) => [row.code, row]));

    for (const item of DEMO_ITEMS) {
      const row = byCode.get(item.code);

      if (!row) {
        continue;
      }

      await transaction
        .insert(inventoryItemLocations)
        .values({
          organizationId,
          inventoryItemId: row.id,
          locationId: location.id,
          parLevel: item.levels.par,
          reorderLevel: item.levels.reorder,
          reorderTarget: item.levels.target,
        })
        .onConflictDoNothing();

      for (const conversion of item.conversions) {
        await transaction
          .insert(inventoryItemUnitConversions)
          .values({
            inventoryItemId: row.id,
            fromUnitId: unit(conversion.from),
            toUnitId: unit(conversion.to),
            factor: conversion.factor,
          })
          .onConflictDoNothing();
      }
    }

    await transaction
      .insert(suppliers)
      .values({ organizationId, code: "DEMO_FOODS", name: "Demo Foods Supply" })
      .onConflictDoNothing();

    const [supplier] = await transaction
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.code, "DEMO_FOODS")));
    const generic = await transaction
      .select({
        fromUnitId: unitConversions.fromUnitId,
        toUnitId: unitConversions.toUnitId,
        factor: unitConversions.factor,
      })
      .from(unitConversions)
      .where(eq(unitConversions.active, true));

    for (const entry of DEMO_SUPPLIER_ITEMS) {
      const row = byCode.get(entry.item);

      if (!row || !supplier) {
        continue;
      }

      const product = await transaction
        .select({
          fromUnitId: inventoryItemUnitConversions.fromUnitId,
          toUnitId: inventoryItemUnitConversions.toUnitId,
          factor: inventoryItemUnitConversions.factor,
        })
        .from(inventoryItemUnitConversions)
        .where(
          and(
            eq(inventoryItemUnitConversions.inventoryItemId, row.id),
            eq(inventoryItemUnitConversions.active, true),
          ),
        );

      await transaction
        .insert(supplierItems)
        .values({
          organizationId,
          supplierId: supplier.id,
          inventoryItemId: row.id,
          supplierSku: entry.sku,
          purchaseUnitId: unit(entry.unit),
          baseUnitsPerPurchase: toBaseQuantity(
            { units: [], generic, product },
            "1",
            unit(entry.unit),
            row.baseUnitId,
          ),
        })
        .onConflictDoNothing();
    }
  },
};
