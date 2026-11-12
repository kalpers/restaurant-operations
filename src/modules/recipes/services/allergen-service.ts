import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import {
  allergens,
  ingredientAllergenReviews,
  inventoryItemAllergens,
  inventoryItems,
  menuItemAllergenReviews,
  menuItemAllergens,
  menuItems,
  recipes,
  recipeVersionIngredients,
  recipeVersions,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { listAllergens } from "../queries/allergen-facts";
import type { AllergenKind } from "../rules/allergen-label";
import { assertPermission } from "./access";

// Phase 21 allergen setup (policies 6, 9, 10, 18), under `recipes.allergens.manage`. Saving an
// ingredient's tags or a menu item's declarations replaces them and stamps the review (D9), in
// one transaction with its audit row. Sent items keep their own snapshot, so nothing here
// changes history, and nothing touches stock.

const PERMISSION = "recipes.allergens.manage";

export async function listAllergenChoices(executor: DatabaseExecutor, actor: Actor) {
  return listAllergens(executor, actor.organizationId);
}

export async function createAllergen(
  database: Database,
  actor: Actor,
  input: { code: string; name: string; displayOrder: number },
) {
  assertPermission(actor, PERMISSION);

  try {
    return await withTransaction(database, async (transaction) => {
      const [row] = await transaction
        .insert(allergens)
        .values({ organizationId: actor.organizationId, code: input.code, name: input.name.trim(), displayOrder: input.displayOrder })
        .returning();

      await recordAudit(transaction, actor, {
        action: "recipes.allergen-changed",
        entityId: row!.id,
        after: { code: row!.code, name: row!.name, active: row!.active },
      });

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("ALLERGEN_CODE_TAKEN", "An allergen with that code already exists.");
    }

    throw error;
  }
}

export async function updateAllergen(
  database: Database,
  actor: Actor,
  input: { allergenId: string; name: string; displayOrder: number; active: boolean; expectedVersion: number },
) {
  assertPermission(actor, PERMISSION);

  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select()
      .from(allergens)
      .where(and(eq(allergens.id, input.allergenId), eq(allergens.organizationId, actor.organizationId)))
      .for("update");

    if (!current) {
      throw new NotFoundError("allergen");
    }

    if (current.version !== input.expectedVersion) {
      throw new ConcurrencyError("allergen", current.id);
    }

    const [row] = await transaction
      .update(allergens)
      .set({
        name: input.name.trim(),
        displayOrder: input.displayOrder,
        active: input.active,
        version: sql`${allergens.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(allergens.id, current.id))
      .returning();

    await recordAudit(transaction, actor, {
      action: "recipes.allergen-changed",
      entityId: current.id,
      before: { code: current.code, name: current.name, active: current.active },
      after: { code: row!.code, name: row!.name, active: row!.active },
    });

    return row!;
  });
}

/** The allergen IDs must be this organization's; inactive ones may stay on what already has them. */
async function requireAllergens(executor: DatabaseExecutor, actor: Actor, ids: readonly string[], kept: ReadonlySet<string>) {
  const unique = [...new Set(ids)];

  if (unique.length === 0) {
    return new Map<string, string>();
  }

  const rows = await executor
    .select({ id: allergens.id, code: allergens.code, active: allergens.active })
    .from(allergens)
    .where(and(eq(allergens.organizationId, actor.organizationId), inArray(allergens.id, unique)));

  if (rows.length !== unique.length) {
    throw new NotFoundError("allergen");
  }

  if (rows.some((row) => !row.active && !kept.has(row.id))) {
    throw new BusinessRuleError("ALLERGEN_INACTIVE", "An inactive allergen can't be added.");
  }

  return new Map(rows.map((row) => [row.id, row.code]));
}

async function codesFor(executor: DatabaseExecutor, ids: readonly string[]) {
  if (ids.length === 0) {
    return [];
  }

  const rows = await executor.select({ code: allergens.code }).from(allergens).where(inArray(allergens.id, [...ids]));

  return rows.map((row) => row.code).sort();
}

function assertReviewVersion(current: { version: number } | undefined, expected: number | null, label: string, id: string) {
  if ((current?.version ?? null) !== expected) {
    throw new ConcurrencyError(label, id);
  }
}

/** Checks the expected review version (null: never reviewed) and stamps a new review. */
async function stampIngredientReview(transaction: DatabaseTransaction, actor: Actor, inventoryItemId: string, expected: number | null) {
  const now = new Date();
  const [current] = await transaction
    .select({ id: ingredientAllergenReviews.id, version: ingredientAllergenReviews.version })
    .from(ingredientAllergenReviews)
    .where(eq(ingredientAllergenReviews.inventoryItemId, inventoryItemId))
    .for("update");

  assertReviewVersion(current, expected, "ingredient allergen review", inventoryItemId);

  const returning = { version: ingredientAllergenReviews.version, reviewedAt: ingredientAllergenReviews.reviewedAt };
  const [row] = current
    ? await transaction
        .update(ingredientAllergenReviews)
        .set({ reviewedAt: now, reviewedByUserId: actor.userId, version: sql`${ingredientAllergenReviews.version} + 1`, updatedAt: now })
        .where(eq(ingredientAllergenReviews.id, current.id))
        .returning(returning)
    : await transaction
        .insert(ingredientAllergenReviews)
        .values({ organizationId: actor.organizationId, inventoryItemId, reviewedAt: now, reviewedByUserId: actor.userId })
        .returning(returning);

  return row!;
}

/** The same for a menu item's declarations. */
async function stampMenuItemReview(transaction: DatabaseTransaction, actor: Actor, menuItemId: string, expected: number | null) {
  const now = new Date();
  const [current] = await transaction
    .select({ id: menuItemAllergenReviews.id, version: menuItemAllergenReviews.version })
    .from(menuItemAllergenReviews)
    .where(eq(menuItemAllergenReviews.menuItemId, menuItemId))
    .for("update");

  assertReviewVersion(current, expected, "menu item allergen review", menuItemId);

  const returning = { version: menuItemAllergenReviews.version, reviewedAt: menuItemAllergenReviews.reviewedAt };
  const [row] = current
    ? await transaction
        .update(menuItemAllergenReviews)
        .set({ reviewedAt: now, reviewedByUserId: actor.userId, version: sql`${menuItemAllergenReviews.version} + 1`, updatedAt: now })
        .where(eq(menuItemAllergenReviews.id, current.id))
        .returning(returning)
    : await transaction
        .insert(menuItemAllergenReviews)
        .values({ organizationId: actor.organizationId, menuItemId, reviewedAt: now, reviewedByUserId: actor.userId })
        .returning(returning);

  return row!;
}

/** Replaces an ingredient's allergen tags (even with none) and marks it reviewed. */
export async function setIngredientAllergens(
  database: Database,
  actor: Actor,
  input: { inventoryItemId: string; allergenIds: readonly string[]; expectedReviewVersion: number | null },
) {
  assertPermission(actor, PERMISSION);

  try {
    return await withTransaction(database, async (transaction) => {
      const [item] = await transaction
        .select({ id: inventoryItems.id, code: inventoryItems.code })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, input.inventoryItemId), eq(inventoryItems.organizationId, actor.organizationId)));

      if (!item) {
        throw new NotFoundError("inventory item");
      }

      const before = await transaction
        .select({ allergenId: inventoryItemAllergens.allergenId })
        .from(inventoryItemAllergens)
        .where(eq(inventoryItemAllergens.inventoryItemId, item.id));
      const beforeIds = new Set(before.map((row) => row.allergenId));

      await requireAllergens(transaction, actor, input.allergenIds, beforeIds);

      const review = await stampIngredientReview(transaction, actor, item.id, input.expectedReviewVersion);
      const afterIds = [...new Set(input.allergenIds)];

      await transaction.delete(inventoryItemAllergens).where(eq(inventoryItemAllergens.inventoryItemId, item.id));

      if (afterIds.length > 0) {
        await transaction
          .insert(inventoryItemAllergens)
          .values(afterIds.map((allergenId) => ({ organizationId: actor.organizationId, inventoryItemId: item.id, allergenId })));
      }

      await recordAudit(transaction, actor, {
        action: "recipes.ingredient-allergens-changed",
        entityId: item.id,
        before: { itemCode: item.code, allergenCodes: await codesFor(transaction, [...beforeIds]) },
        after: { itemCode: item.code, allergenCodes: await codesFor(transaction, afterIds) },
      });

      return { inventoryItemId: item.id, allergenIds: afterIds, reviewVersion: review.version, reviewedAt: review.reviewedAt };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConcurrencyError("ingredient allergen review", input.inventoryItemId);
    }

    throw error;
  }
}

/** Replaces a menu item's declared allergens (even with none) and marks them reviewed. */
export async function setMenuItemAllergens(
  database: Database,
  actor: Actor,
  input: {
    menuItemId: string;
    declared: readonly { allergenId: string; kind: AllergenKind }[];
    expectedReviewVersion: number | null;
  },
) {
  assertPermission(actor, PERMISSION);

  const ids = input.declared.map((entry) => entry.allergenId);

  if (new Set(ids).size !== ids.length) {
    throw new BusinessRuleError("ALLERGEN_DUPLICATE", "Declare each allergen once.");
  }

  try {
    return await withTransaction(database, async (transaction) => {
      const [item] = await transaction
        .select({ id: menuItems.id, code: menuItems.code })
        .from(menuItems)
        .where(and(eq(menuItems.id, input.menuItemId), eq(menuItems.organizationId, actor.organizationId)));

      if (!item) {
        throw new NotFoundError("menu item");
      }

      const before = await transaction
        .select({ allergenId: menuItemAllergens.allergenId, kind: menuItemAllergens.kind })
        .from(menuItemAllergens)
        .where(eq(menuItemAllergens.menuItemId, item.id));
      const codes = await requireAllergens(transaction, actor, ids, new Set(before.map((row) => row.allergenId)));
      const beforeCodes = await describeDeclared(transaction, before);
      const review = await stampMenuItemReview(transaction, actor, item.id, input.expectedReviewVersion);

      await transaction.delete(menuItemAllergens).where(eq(menuItemAllergens.menuItemId, item.id));

      if (input.declared.length > 0) {
        await transaction.insert(menuItemAllergens).values(
          input.declared.map((entry) => ({
            organizationId: actor.organizationId,
            menuItemId: item.id,
            allergenId: entry.allergenId,
            kind: entry.kind,
          })),
        );
      }

      await recordAudit(transaction, actor, {
        action: "recipes.menu-item-allergens-changed",
        entityId: item.id,
        before: { itemCode: item.code, declared: beforeCodes },
        after: {
          itemCode: item.code,
          declared: input.declared.map((entry) => `${codes.get(entry.allergenId)}:${entry.kind}`).sort(),
        },
      });

      return { menuItemId: item.id, declared: input.declared, reviewVersion: review.version, reviewedAt: review.reviewedAt };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConcurrencyError("menu item allergen review", input.menuItemId);
    }

    throw error;
  }
}

async function describeDeclared(executor: DatabaseExecutor, rows: readonly { allergenId: string; kind: string }[]) {
  if (rows.length === 0) {
    return [];
  }

  const found = await executor
    .select({ id: allergens.id, code: allergens.code })
    .from(allergens)
    .where(inArray(allergens.id, rows.map((row) => row.allergenId)));
  const byId = new Map(found.map((row) => [row.id, row.code]));

  return rows.map((row) => `${byId.get(row.allergenId)}:${row.kind}`).sort();
}

/**
 * Active ingredients used by a published or draft recipe revision that nobody has reviewed:
 * the work left before labels are complete (policy 18).
 */
export async function listIngredientsNeedingReview(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, PERMISSION);

  return executor
    .selectDistinct({ id: inventoryItems.id, code: inventoryItems.code, name: inventoryItems.name })
    .from(inventoryItems)
    .innerJoin(recipeVersionIngredients, eq(recipeVersionIngredients.inventoryItemId, inventoryItems.id))
    .innerJoin(recipeVersions, eq(recipeVersions.id, recipeVersionIngredients.recipeVersionId))
    .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
    .where(
      and(
        eq(inventoryItems.organizationId, actor.organizationId),
        eq(inventoryItems.active, true),
        inArray(recipeVersions.status, ["DRAFT", "PUBLISHED"]),
        isNull(recipeVersions.effectiveTo),
        notExists(
          executor
            .select({ one: sql`1` })
            .from(ingredientAllergenReviews)
            .where(eq(ingredientAllergenReviews.inventoryItemId, inventoryItems.id)),
        ),
      ),
    )
    .orderBy(asc(inventoryItems.name));
}
