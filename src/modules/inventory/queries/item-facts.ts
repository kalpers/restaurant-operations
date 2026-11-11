import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { inventoryBalances, inventoryItemLocations, inventoryItems, unitsOfMeasure } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { toScale } from "@/shared/decimal/decimal";

import {
  convertItemQuantity,
  findItemFacts,
  loadConversionContexts,
  type ItemFacts,
} from "../repositories/conversion-repository";
import { toBaseQuantity } from "../rules/unit-resolution";

// The narrow door other domains (Recipes, Menu, and later Orders) use to read Inventory
// Item identity and unit convertibility, and (Phase 19) on-hand quantities for the 86 board.
// It reads; it never writes stock, and it never returns cost, levels or supplier data.

export type { ItemFacts };

/** An active-or-inactive item in the organization, or null: another tenant's looks absent. */
export function getInventoryItemFacts(
  executor: DatabaseExecutor,
  organizationId: string,
  inventoryItemId: string,
): Promise<ItemFacts | null> {
  return findItemFacts(executor, organizationId, inventoryItemId);
}

/**
 * Converts a quantity of the item to its base unit, throwing a business-rule error when
 * the unit can't be converted. Used to check that a recipe or modifier unit is compatible.
 */
export function toItemBaseQuantity(
  executor: DatabaseExecutor,
  item: { id: string; baseUnitId: string },
  quantity: string,
  unitId: string,
): Promise<string> {
  return convertItemQuantity(executor, item, quantity, unitId);
}

/**
 * Converts many quantities at once, loading conversions in three queries in all. The same rule as
 * `toItemBaseQuantity` (one call each would give the same results), for read paths that
 * resolve a whole menu, such as Phase 19 portions remaining.
 */
export async function toItemBaseQuantities(
  executor: DatabaseExecutor,
  requests: readonly { item: { id: string; baseUnitId: string }; quantity: string; unitId: string }[],
): Promise<string[]> {
  const contexts = await loadConversionContexts(
    executor,
    requests.map((request) => request.item.id),
  );
  const results: string[] = [];

  for (const request of requests) {
    results.push(toBaseQuantity(contexts.get(request.item.id)!, request.quantity, request.unitId, request.item.baseUnitId));
  }

  return results;
}

/**
 * Active item identities for pickers in other domains (recipe ingredients, modifier
 * effects). Identity and stock unit only: no quantity, cost or supplier data.
 */
export async function listInventoryItemChoices(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      baseUnitId: inventoryItems.baseUnitId,
      baseUnitCode: unitsOfMeasure.code,
    })
    .from(inventoryItems)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryItems.baseUnitId))
    .where(and(eq(inventoryItems.organizationId, organizationId), eq(inventoryItems.active, true)))
    .orderBy(asc(inventoryItems.name));
}

/** The unit vocabulary, for pickers. Reference data: nothing sensitive. */
export async function listUnitPickerChoices(executor: DatabaseExecutor) {
  return executor
    .select({ id: unitsOfMeasure.id, code: unitsOfMeasure.code })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.active, true))
    .orderBy(asc(unitsOfMeasure.code));
}

/** Item ID to name, and nothing else, for screens in other domains that only need to say which. */
export async function findInventoryItemNames(
  executor: DatabaseExecutor,
  organizationId: string,
  inventoryItemIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(inventoryItemIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ id: inventoryItems.id, name: inventoryItems.name })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, organizationId), inArray(inventoryItems.id, ids)));

  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * On-hand quantities (base units) at a location for other domains' read paths, such as the
 * Phase 19 portions-remaining figure. Quantities only: no cost, levels or supplier data. An
 * item that isn't actively stocked here, or is inactive, is reported as not stocked.
 */
export async function quantitiesOnHand(
  executor: DatabaseExecutor,
  organizationId: string,
  locationId: string,
  inventoryItemIds: readonly string[],
): Promise<Map<string, { stocked: boolean; quantityOnHand: string }>> {
  const result = new Map<string, { stocked: boolean; quantityOnHand: string }>();

  for (const id of inventoryItemIds) {
    result.set(id, { stocked: false, quantityOnHand: "0.0000" });
  }

  if (inventoryItemIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({
      inventoryItemId: inventoryItemLocations.inventoryItemId,
      stocked: sql<boolean>`${inventoryItemLocations.active} AND ${inventoryItems.active}`,
      quantityOnHand: inventoryBalances.quantityOnHand,
    })
    .from(inventoryItemLocations)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryItemLocations.inventoryItemId))
    .leftJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.inventoryItemId, inventoryItemLocations.inventoryItemId),
        eq(inventoryBalances.locationId, inventoryItemLocations.locationId),
      ),
    )
    .where(
      and(
        eq(inventoryItemLocations.locationId, locationId),
        eq(inventoryItems.organizationId, organizationId),
        inArray(inventoryItemLocations.inventoryItemId, [...inventoryItemIds]),
      ),
    );

  for (const row of rows) {
    result.set(row.inventoryItemId, {
      stocked: row.stocked,
      quantityOnHand: toScale(row.quantityOnHand ?? "0", 4),
    });
  }

  return result;
}
