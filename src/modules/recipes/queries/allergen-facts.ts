import { and, asc, eq, inArray } from "drizzle-orm";

import {
  allergens,
  ingredientAllergenReviews,
  inventoryItemAllergens,
  menuItemAllergenReviews,
  menuItemAllergens,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import { resolveItemAllergens, type AllergenInfo, type AllergenKind, type AllergenLabel } from "../rules/allergen-label";
import { resolveCurrentRequirementsForMenuItems } from "./menu-item-requirements";

// Phase 21 (policy 11): the facts every allergen label is built from, in a few queries for
// any number of lines. Callers pass each line's final ingredients (after the recipe and
// modifier effects), so the order screen, the menu page and SEND build one label one way.

export type AllergenRow = AllergenInfo & { displayOrder: number; active: boolean; version: number };

/** The organization's allergen list, in display order. */
export async function listAllergens(executor: DatabaseExecutor, organizationId: string): Promise<AllergenRow[]> {
  return executor
    .select({
      id: allergens.id,
      code: allergens.code,
      name: allergens.name,
      displayOrder: allergens.displayOrder,
      active: allergens.active,
      version: allergens.version,
    })
    .from(allergens)
    .where(eq(allergens.organizationId, organizationId))
    .orderBy(asc(allergens.displayOrder), asc(allergens.name));
}

export type LabelLine = { key: string; menuItemId: string; ingredientIds: readonly string[] };

/** One label per line key. */
export async function loadAllergenLabels(
  executor: DatabaseExecutor,
  organizationId: string,
  lines: readonly LabelLine[],
): Promise<Map<string, AllergenLabel>> {
  const result = new Map<string, AllergenLabel>();

  if (lines.length === 0) {
    return result;
  }

  const ingredientIds = [...new Set(lines.flatMap((line) => line.ingredientIds))];
  const menuItemIds = [...new Set(lines.map((line) => line.menuItemId))];
  const [allergenRows, tagRows, reviewRows, declaredRows, declarationReviewRows] = await Promise.all([
    listAllergens(executor, organizationId),
    ingredientIds.length === 0
      ? Promise.resolve([])
      : executor
          .select({ inventoryItemId: inventoryItemAllergens.inventoryItemId, allergenId: inventoryItemAllergens.allergenId })
          .from(inventoryItemAllergens)
          .where(
            and(
              eq(inventoryItemAllergens.organizationId, organizationId),
              inArray(inventoryItemAllergens.inventoryItemId, ingredientIds),
            ),
          ),
    ingredientIds.length === 0
      ? Promise.resolve([])
      : executor
          .select({ inventoryItemId: ingredientAllergenReviews.inventoryItemId })
          .from(ingredientAllergenReviews)
          .where(
            and(
              eq(ingredientAllergenReviews.organizationId, organizationId),
              inArray(ingredientAllergenReviews.inventoryItemId, ingredientIds),
            ),
          ),
    executor
      .select({ menuItemId: menuItemAllergens.menuItemId, allergenId: menuItemAllergens.allergenId, kind: menuItemAllergens.kind })
      .from(menuItemAllergens)
      .where(and(eq(menuItemAllergens.organizationId, organizationId), inArray(menuItemAllergens.menuItemId, menuItemIds))),
    executor
      .select({ menuItemId: menuItemAllergenReviews.menuItemId })
      .from(menuItemAllergenReviews)
      .where(
        and(eq(menuItemAllergenReviews.organizationId, organizationId), inArray(menuItemAllergenReviews.menuItemId, menuItemIds)),
      ),
  ]);
  const allergenInfo = new Map(allergenRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name }]));
  const ingredientAllergens = new Map<string, string[]>();

  for (const row of tagRows) {
    ingredientAllergens.set(row.inventoryItemId, [...(ingredientAllergens.get(row.inventoryItemId) ?? []), row.allergenId]);
  }

  const reviewedIngredientIds = new Set(reviewRows.map((row) => row.inventoryItemId));
  const reviewedMenuItemIds = new Set(declarationReviewRows.map((row) => row.menuItemId));

  for (const line of lines) {
    result.set(
      line.key,
      resolveItemAllergens({
        ingredientIds: line.ingredientIds,
        ingredientAllergens,
        reviewedIngredientIds,
        declared: declaredRows
          .filter((row) => row.menuItemId === line.menuItemId)
          .map((row) => ({ allergenId: row.allergenId, kind: row.kind as AllergenKind })),
        declarationsReviewed: reviewedMenuItemIds.has(line.menuItemId),
        allergenInfo,
      }),
    );
  }

  return result;
}

/** Each menu item's label as sold with no modifiers, from its recipe in effect `at`. */
export async function loadBaseAllergenLabels(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemIds: readonly string[],
  at: Date,
): Promise<Map<string, AllergenLabel>> {
  const requirements = await resolveCurrentRequirementsForMenuItems(executor, organizationId, menuItemIds, at);

  return loadAllergenLabels(
    executor,
    organizationId,
    menuItemIds.map((menuItemId) => ({
      key: menuItemId,
      menuItemId,
      ingredientIds: (requirements.get(menuItemId) ?? []).map((entry) => entry.inventoryItemId),
    })),
  );
}

/** An ingredient's tags and review, for the inventory item page. */
export async function getIngredientAllergens(executor: DatabaseExecutor, organizationId: string, inventoryItemId: string) {
  const [tags, [review]] = await Promise.all([
    executor
      .select({ allergenId: inventoryItemAllergens.allergenId })
      .from(inventoryItemAllergens)
      .where(
        and(eq(inventoryItemAllergens.organizationId, organizationId), eq(inventoryItemAllergens.inventoryItemId, inventoryItemId)),
      ),
    executor
      .select()
      .from(ingredientAllergenReviews)
      .where(
        and(
          eq(ingredientAllergenReviews.organizationId, organizationId),
          eq(ingredientAllergenReviews.inventoryItemId, inventoryItemId),
        ),
      ),
  ]);

  return { allergenIds: tags.map((row) => row.allergenId), review: review ?? null };
}

/** A menu item's declared allergens and review, for the menu item page. */
export async function getDeclaredAllergens(executor: DatabaseExecutor, organizationId: string, menuItemId: string) {
  const [declared, [review]] = await Promise.all([
    executor
      .select({ allergenId: menuItemAllergens.allergenId, kind: menuItemAllergens.kind })
      .from(menuItemAllergens)
      .where(and(eq(menuItemAllergens.organizationId, organizationId), eq(menuItemAllergens.menuItemId, menuItemId))),
    executor
      .select()
      .from(menuItemAllergenReviews)
      .where(and(eq(menuItemAllergenReviews.organizationId, organizationId), eq(menuItemAllergenReviews.menuItemId, menuItemId))),
  ]);

  return {
    declared: declared.map((row) => ({ allergenId: row.allergenId, kind: row.kind as AllergenKind })),
    review: review ?? null,
  };
}
