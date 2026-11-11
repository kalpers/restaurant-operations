import { and, eq, inArray } from "drizzle-orm";

import { inventoryItems, recipes, recipeVersionIngredients, recipeVersions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { toItemBaseQuantities } from "@/modules/inventory/queries/item-facts";

import { resolveRevisionAt, type RevisionStatus } from "../rules/revision-lifecycle";

// Phase 19 (amendment 5): what one sold portion of each menu item needs right now, for the
// whole menu in a few queries. It gives the same answer as resolving each item's revision with
// `resolveEffectiveRevisionForMenuItem` and its requirements with `resolveRevisionRequirements`,
// which is what SEND does (a test proves the two agree). One sold item consumes the revision's
// ingredient quantities as they are; modifiers are a choice per order and are left out.

export type PortionRequirement = { inventoryItemId: string; baseQuantity: string };

/**
 * Per menu item: its effective revision's base-unit requirements, or null when the item has no
 * recipe or no revision in effect. An empty list means a revision with no ingredients.
 */
export async function resolveCurrentRequirementsForMenuItems(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemIds: readonly string[],
  at: Date,
): Promise<Map<string, PortionRequirement[] | null>> {
  const result = new Map<string, PortionRequirement[] | null>();

  for (const id of menuItemIds) {
    result.set(id, null);
  }

  if (menuItemIds.length === 0) {
    return result;
  }

  const revisionRows = await executor
    .select({ menuItemId: recipes.menuItemId, revision: recipeVersions })
    .from(recipes)
    .innerJoin(recipeVersions, eq(recipeVersions.recipeId, recipes.id))
    .where(and(eq(recipes.organizationId, organizationId), inArray(recipes.menuItemId, [...menuItemIds])));
  const byItem = new Map<string, (typeof recipeVersions.$inferSelect & { status: RevisionStatus })[]>();

  for (const row of revisionRows) {
    const list = byItem.get(row.menuItemId!) ?? [];

    list.push({ ...row.revision, status: row.revision.status as RevisionStatus });
    byItem.set(row.menuItemId!, list);
  }

  const revisionToItem = new Map<string, string>();

  for (const [menuItemId, revisions] of byItem) {
    const effective = resolveRevisionAt(revisions, at);

    if (effective) {
      revisionToItem.set(effective.id, menuItemId);
      result.set(menuItemId, []);
    }
  }

  if (revisionToItem.size === 0) {
    return result;
  }

  const ingredients = await executor
    .select({
      recipeVersionId: recipeVersionIngredients.recipeVersionId,
      inventoryItemId: recipeVersionIngredients.inventoryItemId,
      quantity: recipeVersionIngredients.quantity,
      unitOfMeasureId: recipeVersionIngredients.unitOfMeasureId,
      baseUnitId: inventoryItems.baseUnitId,
    })
    .from(recipeVersionIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeVersionIngredients.inventoryItemId))
    .where(
      and(
        eq(recipeVersionIngredients.organizationId, organizationId),
        inArray(recipeVersionIngredients.recipeVersionId, [...revisionToItem.keys()]),
      ),
    );
  const baseQuantities = await toItemBaseQuantities(
    executor,
    ingredients.map((row) => ({
      item: { id: row.inventoryItemId, baseUnitId: row.baseUnitId },
      quantity: row.quantity,
      unitId: row.unitOfMeasureId,
    })),
  );

  ingredients.forEach((row, index) => {
    const menuItemId = revisionToItem.get(row.recipeVersionId)!;

    result.get(menuItemId)!.push({ inventoryItemId: row.inventoryItemId, baseQuantity: baseQuantities[index]! });
  });

  return result;
}
