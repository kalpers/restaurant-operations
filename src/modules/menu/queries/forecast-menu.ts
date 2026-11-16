import { and, asc, eq, inArray } from "drizzle-orm";

import {
  inventoryItems,
  menuAvailability,
  menuCategories,
  menuItemPlacements,
  menuItemPrepRouting,
  menuItems,
  menuLocations,
  menus,
  modifierInventoryEffects,
  modifiers,
  prepStations,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { toItemBaseQuantities } from "@/modules/inventory/queries/item-facts";
import type { BaseEffect } from "@/modules/recipes/rules/modifier-recipe-effects";

// Phase 25 policy 4 (D3): the items a location can sell on a business date, for the item
// forecast and the prep list. An item counts when it is active and placed (active placement,
// active category) on an active menu offered at the location whose availability windows, if
// any, overlap the date. The `available` flag and 86 state are ignored: an 86 today says
// nothing about next week. Read-only; no prices.

export type ForecastStation = {
  id: string;
  code: string;
  name: string;
  stationType: "KITCHEN" | "BAR" | "EXPO";
};

export type ForecastMenuItem = {
  menuItemId: string;
  code: string;
  name: string;
  /** Active routing to active stations at the location, in routing order. */
  stationIds: string[];
};

export async function getForecastMenu(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; from: Date; to: Date },
): Promise<{ items: ForecastMenuItem[]; stations: ForecastStation[] }> {
  const stationRows = await executor
    .select({
      id: prepStations.id,
      code: prepStations.code,
      name: prepStations.name,
      stationType: prepStations.stationType,
    })
    .from(prepStations)
    .where(and(eq(prepStations.locationId, input.locationId), eq(prepStations.active, true)))
    .orderBy(asc(prepStations.sortOrder), asc(prepStations.name));
  const stations = stationRows.map((row) => ({ ...row, stationType: row.stationType as ForecastStation["stationType"] }));

  const offered = await executor
    .select({ id: menus.id })
    .from(menus)
    .innerJoin(menuLocations, eq(menuLocations.menuId, menus.id))
    .where(
      and(
        eq(menus.organizationId, input.organizationId),
        eq(menus.active, true),
        eq(menuLocations.locationId, input.locationId),
        eq(menuLocations.active, true),
      ),
    );

  if (offered.length === 0) {
    return { items: [], stations };
  }

  const windows = await executor
    .select()
    .from(menuAvailability)
    .where(
      and(
        inArray(
          menuAvailability.menuId,
          offered.map((menu) => menu.id),
        ),
        eq(menuAvailability.locationId, input.locationId),
      ),
    );
  const openMenuIds = offered
    .map((menu) => menu.id)
    .filter((menuId) => {
      const own = windows.filter((window) => window.menuId === menuId);

      return (
        own.length === 0 ||
        own.some(
          (window) =>
            window.effectiveFrom < input.to && (window.effectiveTo === null || input.from < window.effectiveTo),
        )
      );
    });

  if (openMenuIds.length === 0) {
    return { items: [], stations };
  }

  const placed = await executor
    .selectDistinct({ id: menuItems.id, code: menuItems.code, name: menuItems.name })
    .from(menuItemPlacements)
    .innerJoin(menuCategories, eq(menuCategories.id, menuItemPlacements.menuCategoryId))
    .innerJoin(menuItems, eq(menuItems.id, menuItemPlacements.menuItemId))
    .where(
      and(
        inArray(menuItemPlacements.menuId, openMenuIds),
        eq(menuItemPlacements.active, true),
        eq(menuCategories.active, true),
        eq(menuItems.active, true),
      ),
    );

  if (placed.length === 0) {
    return { items: [], stations };
  }

  const routing = await executor
    .select({ menuItemId: menuItemPrepRouting.menuItemId, stationId: prepStations.id })
    .from(menuItemPrepRouting)
    .innerJoin(prepStations, eq(prepStations.id, menuItemPrepRouting.prepStationId))
    .where(
      and(
        inArray(
          menuItemPrepRouting.menuItemId,
          placed.map((item) => item.id),
        ),
        eq(menuItemPrepRouting.locationId, input.locationId),
        eq(menuItemPrepRouting.active, true),
        eq(prepStations.active, true),
      ),
    )
    .orderBy(asc(menuItemPrepRouting.sortOrder), asc(prepStations.name));

  return {
    stations,
    items: placed
      .map((item) => ({
        menuItemId: item.id,
        code: item.code,
        name: item.name,
        stationIds: routing.filter((row) => row.menuItemId === item.id).map((row) => row.stationId),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.menuItemId.localeCompare(b.menuItemId)),
  };
}

export type ForecastModifierEffect = BaseEffect & {
  menuItemId: string;
  modifierId: string;
  modifierName: string;
};

/**
 * Phase 25 policy 5: the current inventory effects of every modifier configured for these
 * menu items, in each Inventory Item's base unit (the conversion SEND uses).
 */
export async function getForecastModifierEffects(
  executor: DatabaseExecutor,
  input: { organizationId: string; menuItemIds: readonly string[] },
): Promise<ForecastModifierEffect[]> {
  if (input.menuItemIds.length === 0) {
    return [];
  }

  const rows = await executor
    .select({
      menuItemId: modifierInventoryEffects.menuItemId,
      modifierId: modifierInventoryEffects.modifierId,
      modifierName: modifiers.name,
      inventoryItemId: modifierInventoryEffects.inventoryItemId,
      effectType: modifierInventoryEffects.effectType,
      quantity: modifierInventoryEffects.quantity,
      unitOfMeasureId: modifierInventoryEffects.unitOfMeasureId,
      baseUnitId: inventoryItems.baseUnitId,
    })
    .from(modifierInventoryEffects)
    .innerJoin(inventoryItems, eq(inventoryItems.id, modifierInventoryEffects.inventoryItemId))
    .innerJoin(modifiers, eq(modifiers.id, modifierInventoryEffects.modifierId))
    .where(
      and(
        eq(modifierInventoryEffects.organizationId, input.organizationId),
        inArray(modifierInventoryEffects.menuItemId, [...input.menuItemIds]),
      ),
    );
  const quantified = rows.filter((row) => row.effectType !== "REMOVE");
  const bases = await toItemBaseQuantities(
    executor,
    quantified.map((row) => ({
      item: { id: row.inventoryItemId, baseUnitId: row.baseUnitId },
      quantity: row.quantity!.startsWith("-") ? row.quantity!.slice(1) : row.quantity!,
      unitId: row.unitOfMeasureId!,
    })),
  );
  const baseByRow = new Map(quantified.map((row, index) => [row, bases[index]!]));

  return rows
    .map((row): ForecastModifierEffect => {
      const common = {
        menuItemId: row.menuItemId,
        modifierId: row.modifierId,
        modifierName: row.modifierName,
        inventoryItemId: row.inventoryItemId,
      };

      if (row.effectType === "REMOVE") {
        return { ...common, operation: "REMOVE" };
      }

      const base = baseByRow.get(row)!;

      return {
        ...common,
        operation: row.effectType as "ADD" | "ADJUST",
        baseQuantity: row.quantity!.startsWith("-") ? `-${base}` : base,
      };
    })
    .sort(
      (a, b) =>
        a.menuItemId.localeCompare(b.menuItemId) ||
        a.modifierId.localeCompare(b.modifierId) ||
        a.inventoryItemId.localeCompare(b.inventoryItemId),
    );
}

/** Phase 25 policy 9: modifier names for the prep list's "about N with …" lines. */
export async function getModifierNames(
  executor: DatabaseExecutor,
  modifierIds: readonly string[],
): Promise<Map<string, string>> {
  if (modifierIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ id: modifiers.id, name: modifiers.name })
    .from(modifiers)
    .where(inArray(modifiers.id, [...new Set(modifierIds)]));

  return new Map(rows.map((row) => [row.id, row.name]));
}
