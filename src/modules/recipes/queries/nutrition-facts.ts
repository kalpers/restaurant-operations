import { and, eq, inArray } from "drizzle-orm";

import { inventoryItemNutrition, menuItemNutrition, NUTRITION_FIGURES } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import {
  resolveNutritionLabel,
  type IngredientNutrition,
  type NutritionLabel,
  type NutritionValues,
} from "../rules/nutrition-label";
import { resolveCurrentRequirementsForMenuItems, type PortionRequirement } from "./menu-item-requirements";

// Phase 28 (policy 12): the facts every nutrition label is built from, in a few queries for any
// number of lines. Callers pass each line's portion requirements after modifiers, so the menu
// item page and the order screen build one label one way. Nothing is stored or snapshotted.

function valuesOf(row: Record<string, unknown>): NutritionValues {
  return Object.fromEntries(NUTRITION_FIGURES.map((figure) => [figure, (row[figure] as string | null) ?? null])) as NutritionValues;
}

export type NutritionLine = { key: string; menuItemId: string; requirements: readonly PortionRequirement[] | null };

export async function loadNutritionLabels(
  executor: DatabaseExecutor,
  organizationId: string,
  lines: readonly NutritionLine[],
): Promise<Map<string, NutritionLabel>> {
  const result = new Map<string, NutritionLabel>();

  if (lines.length === 0) {
    return result;
  }

  const ingredientIds = [...new Set(lines.flatMap((line) => (line.requirements ?? []).map((entry) => entry.inventoryItemId)))];
  const menuItemIds = [...new Set(lines.map((line) => line.menuItemId))];
  const [ingredientRows, declaredRows] = await Promise.all([
    ingredientIds.length === 0
      ? Promise.resolve([])
      : executor
          .select()
          .from(inventoryItemNutrition)
          .where(
            and(
              eq(inventoryItemNutrition.organizationId, organizationId),
              inArray(inventoryItemNutrition.inventoryItemId, ingredientIds),
            ),
          ),
    executor
      .select()
      .from(menuItemNutrition)
      .where(and(eq(menuItemNutrition.organizationId, organizationId), inArray(menuItemNutrition.menuItemId, menuItemIds))),
  ]);
  const ingredients = new Map<string, IngredientNutrition>(
    ingredientRows.map((row) => [row.inventoryItemId, { basisQuantity: row.basisQuantity, ...valuesOf(row) }]),
  );
  const declared = new Map(declaredRows.map((row) => [row.menuItemId, valuesOf(row)]));

  for (const line of lines) {
    result.set(
      line.key,
      resolveNutritionLabel({
        requirements: line.requirements,
        ingredients,
        declared: declared.get(line.menuItemId) ?? null,
      }),
    );
  }

  return result;
}

/** Each menu item's label as sold with no modifiers, from its recipe in effect `at`. */
export async function loadBaseNutritionLabels(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemIds: readonly string[],
  at: Date,
): Promise<Map<string, NutritionLabel>> {
  const requirements = await resolveCurrentRequirementsForMenuItems(executor, organizationId, menuItemIds, at);

  return loadNutritionLabels(
    executor,
    organizationId,
    menuItemIds.map((menuItemId) => ({ key: menuItemId, menuItemId, requirements: requirements.get(menuItemId) ?? null })),
  );
}

/** Names of the ingredients in an item's current recipe that have no nutrition facts. */
export async function ingredientsWithoutNutrition(
  executor: DatabaseExecutor,
  organizationId: string,
  requirements: readonly PortionRequirement[],
): Promise<string[]> {
  if (requirements.length === 0) {
    return [];
  }

  const ids = requirements.map((entry) => entry.inventoryItemId);
  const rows = await executor
    .select({ inventoryItemId: inventoryItemNutrition.inventoryItemId })
    .from(inventoryItemNutrition)
    .where(and(eq(inventoryItemNutrition.organizationId, organizationId), inArray(inventoryItemNutrition.inventoryItemId, ids)));
  const known = new Set(rows.map((row) => row.inventoryItemId));

  return ids.filter((id) => !known.has(id));
}

export async function getIngredientNutrition(executor: DatabaseExecutor, organizationId: string, inventoryItemId: string) {
  const [row] = await executor
    .select()
    .from(inventoryItemNutrition)
    .where(and(eq(inventoryItemNutrition.organizationId, organizationId), eq(inventoryItemNutrition.inventoryItemId, inventoryItemId)));

  return row ? { basisQuantity: row.basisQuantity, values: valuesOf(row), version: row.version } : null;
}

export async function getDeclaredNutrition(executor: DatabaseExecutor, organizationId: string, menuItemId: string) {
  const [row] = await executor
    .select()
    .from(menuItemNutrition)
    .where(and(eq(menuItemNutrition.organizationId, organizationId), eq(menuItemNutrition.menuItemId, menuItemId)));

  return row ? { values: valuesOf(row), version: row.version } : null;
}
