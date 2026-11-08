import { and, asc, eq } from "drizzle-orm";

import { inventoryItems, unitsOfMeasure } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import {
  convertItemQuantity,
  findItemFacts,
  type ItemFacts,
} from "../repositories/conversion-repository";

// The narrow door other domains (Recipes, Menu, and later Orders) use to read Inventory
// Item identity and unit convertibility. It reads; it never writes stock.

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
