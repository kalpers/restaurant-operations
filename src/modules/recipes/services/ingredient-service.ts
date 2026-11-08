import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItems,
  recipes,
  recipeVersionIngredients,
  recipeVersions,
  unitsOfMeasure,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  getInventoryItemFacts,
  toItemBaseQuantity,
} from "@/modules/inventory/queries/item-facts";
import { isPositiveDecimal, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertEditable, type RevisionStatus } from "../rules/revision-lifecycle";
import { assertPermission } from "./access";

// A revision's ingredients reference Inventory Items directly. They can change only while the
// revision is a DRAFT (a database trigger also refuses changes to a published revision's
// rows). Saving an ingredient moves no stock. Each change takes the revision's expected
// version and bumps it, so two editors of one draft can't overwrite each other.

type IngredientInput = {
  inventoryItemId: string;
  quantity: string;
  unitOfMeasureId: string;
  preparationNote: string | null;
  sortOrder: number;
};

async function lockDraft(
  transaction: DatabaseTransaction,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  expectedVersion: number,
) {
  const [row] = await transaction
    .select({ revision: recipeVersions })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
    .where(
      and(
        eq(recipeVersions.id, revisionId),
        eq(recipeVersions.recipeId, recipeId),
        eq(recipes.organizationId, actor.organizationId),
      ),
    )
    .for("update", { of: recipeVersions });

  if (!row) {
    throw new NotFoundError("recipe revision");
  }

  assertEditable(row.revision.status as RevisionStatus);

  if (row.revision.version !== expectedVersion) {
    throw new ConcurrencyError("recipe revision", revisionId);
  }

  return row.revision;
}

async function bumpRevision(transaction: DatabaseTransaction, revisionId: string) {
  const [row] = await transaction
    .update(recipeVersions)
    .set({ version: nextVersion(recipeVersions.version), updatedAt: new Date() })
    .where(eq(recipeVersions.id, revisionId))
    .returning({ version: recipeVersions.version });

  return row!.version;
}

/** Checks the item belongs to the organization, is active, and the unit converts to its base. */
async function validateIngredient(
  executor: DatabaseExecutor,
  actor: Actor,
  input: Pick<IngredientInput, "inventoryItemId" | "quantity" | "unitOfMeasureId">,
): Promise<string> {
  let quantity: string;

  try {
    quantity = toScale(input.quantity, 4);
  } catch {
    throw new BusinessRuleError(
      "INVALID_QUANTITY",
      "An ingredient quantity has at most four decimal places.",
    );
  }

  if (!isPositiveDecimal(quantity)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "An ingredient quantity must be positive.");
  }

  const item = await getInventoryItemFacts(executor, actor.organizationId, input.inventoryItemId);

  if (!item) {
    throw new NotFoundError("inventory item");
  }

  if (!item.active) {
    throw new BusinessRuleError("ITEM_INACTIVE", "That inventory item is inactive.");
  }

  await toItemBaseQuantity(executor, item, quantity, input.unitOfMeasureId);

  return quantity;
}

export async function addIngredient(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  input: IngredientInput & { expectedVersion: number },
) {
  assertPermission(actor, "recipes.edit");

  try {
    return await withTransaction(database, async (transaction) => {
      await lockDraft(transaction, actor, recipeId, revisionId, input.expectedVersion);

      const quantity = await validateIngredient(transaction, actor, input);
      const [row] = await transaction
        .insert(recipeVersionIngredients)
        .values({
          organizationId: actor.organizationId,
          recipeVersionId: revisionId,
          inventoryItemId: input.inventoryItemId,
          quantity,
          unitOfMeasureId: input.unitOfMeasureId,
          preparationNote: input.preparationNote,
          sortOrder: input.sortOrder,
        })
        .returning();

      return { ingredient: row!, revisionVersion: await bumpRevision(transaction, revisionId) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "INGREDIENT_EXISTS",
        "That item is already an ingredient of this revision. Change its quantity instead.",
      );
    }

    throw error;
  }
}

export async function updateIngredient(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  ingredientId: string,
  input: Omit<IngredientInput, "inventoryItemId"> & { expectedVersion: number },
) {
  assertPermission(actor, "recipes.edit");

  return withTransaction(database, async (transaction) => {
    await lockDraft(transaction, actor, recipeId, revisionId, input.expectedVersion);

    const [existing] = await transaction
      .select()
      .from(recipeVersionIngredients)
      .where(
        and(
          eq(recipeVersionIngredients.id, ingredientId),
          eq(recipeVersionIngredients.recipeVersionId, revisionId),
        ),
      );

    if (!existing) {
      throw new NotFoundError("ingredient");
    }

    const quantity = await validateIngredient(transaction, actor, {
      ...input,
      inventoryItemId: existing.inventoryItemId,
    });
    const [row] = await transaction
      .update(recipeVersionIngredients)
      .set({
        quantity,
        unitOfMeasureId: input.unitOfMeasureId,
        preparationNote: input.preparationNote,
        sortOrder: input.sortOrder,
      })
      .where(eq(recipeVersionIngredients.id, ingredientId))
      .returning();

    return { ingredient: row!, revisionVersion: await bumpRevision(transaction, revisionId) };
  });
}

export async function removeIngredient(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  ingredientId: string,
  expectedVersion: number,
) {
  assertPermission(actor, "recipes.edit");

  return withTransaction(database, async (transaction) => {
    await lockDraft(transaction, actor, recipeId, revisionId, expectedVersion);

    const removed = await transaction
      .delete(recipeVersionIngredients)
      .where(
        and(
          eq(recipeVersionIngredients.id, ingredientId),
          eq(recipeVersionIngredients.recipeVersionId, revisionId),
        ),
      )
      .returning({ id: recipeVersionIngredients.id });

    if (removed.length === 0) {
      throw new NotFoundError("ingredient");
    }

    return { revisionVersion: await bumpRevision(transaction, revisionId) };
  });
}

/**
 * Copies another revision's ingredients into a draft, so a new revision starts from the
 * current recipe. The source is read, never changed.
 */
export async function copyIngredients(
  database: Database,
  actor: Actor,
  recipeId: string,
  revisionId: string,
  input: { fromRevisionId: string; expectedVersion: number },
) {
  assertPermission(actor, "recipes.edit");

  return withTransaction(database, async (transaction) => {
    await lockDraft(transaction, actor, recipeId, revisionId, input.expectedVersion);

    const [source] = await transaction
      .select({ id: recipeVersions.id })
      .from(recipeVersions)
      .where(and(eq(recipeVersions.id, input.fromRevisionId), eq(recipeVersions.recipeId, recipeId)));

    if (!source) {
      throw new NotFoundError("recipe revision");
    }

    const [existing] = await transaction
      .select({ id: recipeVersionIngredients.id })
      .from(recipeVersionIngredients)
      .where(eq(recipeVersionIngredients.recipeVersionId, revisionId))
      .limit(1);

    if (existing) {
      throw new BusinessRuleError(
        "DRAFT_HAS_INGREDIENTS",
        "Copy into a draft that has no ingredients yet.",
      );
    }

    const rows = await transaction
      .select()
      .from(recipeVersionIngredients)
      .where(eq(recipeVersionIngredients.recipeVersionId, input.fromRevisionId));

    if (rows.length > 0) {
      await transaction.insert(recipeVersionIngredients).values(
        rows.map((row) => ({
          organizationId: row.organizationId,
          recipeVersionId: revisionId,
          inventoryItemId: row.inventoryItemId,
          quantity: row.quantity,
          unitOfMeasureId: row.unitOfMeasureId,
          preparationNote: row.preparationNote,
          sortOrder: row.sortOrder,
        })),
      );
    }

    return { copied: rows.length, revisionVersion: await bumpRevision(transaction, revisionId) };
  });
}

/** Ingredient rows for revisions, with item and unit names, ordered for display. */
export async function listIngredients(executor: DatabaseExecutor, revisionIds: readonly string[]) {
  if (revisionIds.length === 0) {
    return [];
  }

  return executor
    .select({
      id: recipeVersionIngredients.id,
      recipeVersionId: recipeVersionIngredients.recipeVersionId,
      inventoryItemId: recipeVersionIngredients.inventoryItemId,
      inventoryItemName: inventoryItems.name,
      quantity: recipeVersionIngredients.quantity,
      unitOfMeasureId: recipeVersionIngredients.unitOfMeasureId,
      unitCode: unitsOfMeasure.code,
      preparationNote: recipeVersionIngredients.preparationNote,
      sortOrder: recipeVersionIngredients.sortOrder,
    })
    .from(recipeVersionIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeVersionIngredients.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, recipeVersionIngredients.unitOfMeasureId))
    .where(inArray(recipeVersionIngredients.recipeVersionId, [...revisionIds]))
    .orderBy(asc(recipeVersionIngredients.sortOrder), asc(inventoryItems.name));
}

/**
 * A revision's requirements in each item's base unit, for Phase 9 consumption. Internal:
 * the caller authorizes, and the organization is checked here.
 */
export async function resolveRevisionRequirements(
  executor: DatabaseExecutor,
  organizationId: string,
  revisionId: string,
) {
  const rows = await executor
    .select({
      inventoryItemId: recipeVersionIngredients.inventoryItemId,
      quantity: recipeVersionIngredients.quantity,
      unitOfMeasureId: recipeVersionIngredients.unitOfMeasureId,
      baseUnitId: inventoryItems.baseUnitId,
    })
    .from(recipeVersionIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeVersionIngredients.inventoryItemId))
    .where(
      and(
        eq(recipeVersionIngredients.recipeVersionId, revisionId),
        eq(recipeVersionIngredients.organizationId, organizationId),
      ),
    );
  const result = [];

  for (const row of rows) {
    result.push({
      inventoryItemId: row.inventoryItemId,
      baseQuantity: await toItemBaseQuantity(
        executor,
        { id: row.inventoryItemId, baseUnitId: row.baseUnitId },
        row.quantity,
        row.unitOfMeasureId,
      ),
    });
  }

  return result;
}
