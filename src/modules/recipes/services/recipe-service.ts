import { and, asc, desc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { nextVersion } from "@/db/helpers/versioning";
import {
  menuItems,
  recipes,
  recipeVersionIngredients,
  recipeVersions,
  unitsOfMeasure,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  assertEditable,
  nextRevisionNumber,
  normalizeYield,
  planPublish,
  planRetire,
  resolveRevisionAt,
  type RevisionRow,
  type RevisionStatus,
} from "../rules/revision-lifecycle";
import { assertPermission } from "./access";
import { listIngredients } from "./ingredient-service";

// Recipe identity and revisions. Ingredients (Inventory Item references) are managed in
// `ingredient-service.ts`. Nothing here reads or writes stock.

type RecipeInput = {
  name: string;
  description: string | null;
  menuItemId: string | null;
};

type RevisionRecord = typeof recipeVersions.$inferSelect;

const toRow = (row: RevisionRecord): RevisionRow & RevisionRecord => ({
  ...row,
  status: row.status as RevisionStatus,
});

async function requireMenuItemInOrganization(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
) {
  const [item] = await executor
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }
}

const itemAlreadyHasRecipe = () =>
  new ConflictError("RECIPE_EXISTS_FOR_ITEM", "That menu item already has a recipe.");

// ------------------------------------------------------------------ identity

export async function listRecipes(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "recipes.view");

  return executor
    .select({
      id: recipes.id,
      code: recipes.code,
      name: recipes.name,
      active: recipes.active,
      menuItemId: recipes.menuItemId,
      menuItemName: menuItems.name,
      version: recipes.version,
    })
    .from(recipes)
    .leftJoin(menuItems, eq(menuItems.id, recipes.menuItemId))
    .where(eq(recipes.organizationId, actor.organizationId))
    .orderBy(asc(recipes.name));
}

export async function createRecipe(
  database: Database,
  actor: Actor,
  input: RecipeInput & { code: string },
) {
  assertPermission(actor, "recipes.edit");

  try {
    return await withTransaction(database, async (transaction) => {
      if (input.menuItemId) {
        await requireMenuItemInOrganization(transaction, actor, input.menuItemId);
      }

      const [row] = await transaction
        .insert(recipes)
        .values({ ...input, organizationId: actor.organizationId })
        .returning();

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw input.menuItemId
        ? new ConflictError("CODE_OR_ITEM_TAKEN", "That recipe code, or that menu item's recipe, already exists.")
        : new ConflictError("CODE_TAKEN", "Another recipe already uses that code.");
    }

    throw error;
  }
}

export async function updateRecipe(
  database: Database,
  actor: Actor,
  recipeId: string,
  input: RecipeInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "recipes.edit");

  const { expectedVersion, ...values } = input;

  try {
    return await withTransaction(database, async (transaction) => {
      if (input.menuItemId) {
        await requireMenuItemInOrganization(transaction, actor, input.menuItemId);
      }

      return updateVersioned(transaction, recipes, {
        id: recipeId,
        organizationId: actor.organizationId,
        expectedVersion,
        values,
        label: "recipe",
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw itemAlreadyHasRecipe();
    }

    throw error;
  }
}

/** Identity plus every revision, newest first, and the one in effect at `now`. */
export async function getRecipeDetail(
  executor: DatabaseExecutor,
  actor: Actor,
  recipeId: string,
  now: Date = new Date(),
) {
  assertPermission(actor, "recipes.view");

  const [recipe] = await executor
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.organizationId, actor.organizationId)));

  if (!recipe) {
    throw new NotFoundError("recipe");
  }

  const revisions = (
    await executor
      .select({ revision: recipeVersions, yieldUnitCode: unitsOfMeasure.code })
      .from(recipeVersions)
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, recipeVersions.yieldUnitId))
      .where(eq(recipeVersions.recipeId, recipeId))
      .orderBy(desc(recipeVersions.revisionNumber))
  ).map(({ revision, yieldUnitCode }) => ({ ...toRow(revision), yieldUnitCode }));

  const ingredients = await listIngredients(
    executor,
    revisions.map((revision) => revision.id),
  );

  return {
    recipe,
    revisions: revisions.map((revision) => ({
      ...revision,
      ingredients: ingredients.filter((row) => row.recipeVersionId === revision.id),
    })),
    effectiveRevisionId: resolveRevisionAt(revisions, now)?.id ?? null,
  };
}

// ----------------------------------------------------------------- revisions

type DraftInput = {
  yieldQuantity: string;
  yieldUnitId: string | null;
  preparationNotes: string | null;
};

async function requireYieldUnit(executor: DatabaseExecutor, unitId: string | null) {
  if (unitId === null) {
    return;
  }

  const [unit] = await executor
    .select({ id: unitsOfMeasure.id, active: unitsOfMeasure.active })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.id, unitId));

  if (!unit) {
    throw new NotFoundError("unit of measure");
  }

  if (!unit.active) {
    throw new BusinessRuleError("UNIT_INACTIVE", "That unit of measure is no longer in use.");
  }
}

/** Locks the recipe so revisions of one recipe are numbered and published one at a time. */
async function lockRecipe(transaction: DatabaseTransaction, actor: Actor, recipeId: string) {
  const [recipe] = await transaction
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.organizationId, actor.organizationId)))
    .for("update");

  if (!recipe) {
    throw new NotFoundError("recipe");
  }
}

async function loadRevisions(transaction: DatabaseTransaction, recipeId: string) {
  return (
    await transaction.select().from(recipeVersions).where(eq(recipeVersions.recipeId, recipeId))
  ).map(toRow);
}

export async function createDraftRevision(
  database: Database,
  actor: Actor,
  recipeId: string,
  input: DraftInput,
) {
  assertPermission(actor, "recipes.edit");

  const yieldQuantity = normalizeYield(input.yieldQuantity);

  return withTransaction(database, async (transaction) => {
    await lockRecipe(transaction, actor, recipeId);
    await requireYieldUnit(transaction, input.yieldUnitId);

    const revisions = await loadRevisions(transaction, recipeId);
    const [row] = await transaction
      .insert(recipeVersions)
      .values({
        recipeId,
        revisionNumber: nextRevisionNumber(revisions),
        yieldQuantity,
        yieldUnitId: input.yieldUnitId,
        preparationNotes: input.preparationNotes,
        createdByUserId: actor.userId,
      })
      .returning();

    return row!;
  });
}

async function updateRevision(
  transaction: DatabaseTransaction,
  recipeId: string,
  revisionId: string,
  expectedVersion: number,
  values: Record<string, unknown>,
) {
  const rows = await transaction
    .update(recipeVersions)
    .set({ ...values, version: nextVersion(recipeVersions.version), updatedAt: new Date() } as never)
    .where(
      and(
        eq(recipeVersions.id, revisionId),
        eq(recipeVersions.recipeId, recipeId),
        eq(recipeVersions.version, expectedVersion),
      ),
    )
    .returning();

  if (!rows[0]) {
    throw new ConcurrencyError("recipe revision", revisionId);
  }

  return rows[0];
}

async function requireRevision(
  transaction: DatabaseTransaction,
  recipeId: string,
  revisionId: string,
) {
  const [revision] = await transaction
    .select()
    .from(recipeVersions)
    .where(and(eq(recipeVersions.id, revisionId), eq(recipeVersions.recipeId, recipeId)));

  if (!revision) {
    throw new NotFoundError("recipe revision");
  }

  return toRow(revision);
}

/** Edits a draft. A published revision is immutable; a database trigger also enforces it. */
export async function updateDraftRevision(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  input: DraftInput & { expectedVersion: number },
) {
  assertPermission(actor, "recipes.edit");

  const yieldQuantity = normalizeYield(input.yieldQuantity);

  return withTransaction(database, async (transaction) => {
    await lockRecipe(transaction, actor, recipeId);

    const revision = await requireRevision(transaction, recipeId, revisionId);

    assertEditable(revision.status);
    await requireYieldUnit(transaction, input.yieldUnitId);

    return updateRevision(transaction, recipeId, revisionId, input.expectedVersion, {
      yieldQuantity,
      yieldUnitId: input.yieldUnitId,
      preparationNotes: input.preparationNotes,
    });
  });
}

/**
 * Publishes a draft. The earlier revision in force is closed where this one begins, and
 * this one takes effect, in one transaction. `effectiveFrom` null means now.
 */
export async function publishRevision(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  input: { effectiveFrom: Date | null; expectedVersion: number },
  now: Date = new Date(),
) {
  assertPermission(actor, "recipes.edit");

  try {
    return await withTransaction(database, async (transaction) => {
      await lockRecipe(transaction, actor, recipeId);

      const revisions = await loadRevisions(transaction, recipeId);
      const draft = revisions.find((row) => row.id === revisionId);

      if (!draft) {
        throw new NotFoundError("recipe revision");
      }

      const plan = planPublish(revisions, draft, input.effectiveFrom, now);

      if (plan.closePrior) {
        await transaction
          .update(recipeVersions)
          .set({ effectiveTo: plan.closePrior.at, updatedAt: now })
          .where(eq(recipeVersions.id, plan.closePrior.id));
      }

      return await updateRevision(transaction, recipeId, revisionId, input.expectedVersion, {
        status: "PUBLISHED",
        effectiveFrom: plan.effectiveFrom,
        publishedByUserId: actor.userId,
        publishedAt: now,
      });
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError(
        "REVISION_OVERLAP",
        "That revision would overlap another one in effect.",
      );
    }

    throw error;
  }
}

/** Ends a published revision. Its content and interval stay as history. */
export async function retireRevision(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  input: { expectedVersion: number },
  now: Date = new Date(),
) {
  assertPermission(actor, "recipes.edit");

  return withTransaction(database, async (transaction) => {
    await lockRecipe(transaction, actor, recipeId);

    const revision = await requireRevision(transaction, recipeId, revisionId);
    const plan = planRetire(revision, now);

    return updateRevision(transaction, recipeId, revisionId, input.expectedVersion, {
      status: "RETIRED",
      effectiveTo: plan.effectiveTo,
      retiredByUserId: actor.userId,
      retiredAt: now,
    });
  });
}

/** Discards a draft that was never published. Published revisions are history. */
export async function deleteDraftRevision(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
) {
  assertPermission(actor, "recipes.edit");

  await withTransaction(database, async (transaction) => {
    await lockRecipe(transaction, actor, recipeId);
    assertEditable((await requireRevision(transaction, recipeId, revisionId)).status);
    await transaction
      .delete(recipeVersionIngredients)
      .where(eq(recipeVersionIngredients.recipeVersionId, revisionId));
    await transaction.delete(recipeVersions).where(eq(recipeVersions.id, revisionId));
  });
}

// ---------------------------------------------------------------- resolution

/**
 * The revision of a recipe in effect at an instant, or null. For Phase 8 and 9, which
 * must identify the revision that applied when an event happened. Internal: callers
 * check their own permissions, and the organization is checked here.
 */
export async function resolveEffectiveRevision(
  executor: DatabaseExecutor,
  organizationId: string,
  recipeId: string,
  at: Date,
) {
  const [recipe] = await executor
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.organizationId, organizationId)));

  if (!recipe) {
    return null;
  }

  const revisions = (
    await executor.select().from(recipeVersions).where(eq(recipeVersions.recipeId, recipeId))
  ).map(toRow);

  return resolveRevisionAt(revisions, at);
}

/** The effective revision of the recipe linked to a menu item, resolved separately. */
export async function resolveEffectiveRevisionForMenuItem(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemId: string,
  at: Date,
) {
  const [recipe] = await executor
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.menuItemId, menuItemId), eq(recipes.organizationId, organizationId)));

  return recipe ? resolveEffectiveRevision(executor, organizationId, recipe.id, at) : null;
}
