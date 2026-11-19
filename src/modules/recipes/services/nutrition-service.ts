import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { inventoryItemNutrition, inventoryItems, menuItemNutrition, menuItems, NUTRITION_FIGURES } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import type { NutritionFigure, NutritionValues } from "../rules/nutrition-label";
import { assertPermission } from "./access";

// Phase 28 nutrition setup (policies 11 and 12), under `recipes.edit`. An ingredient's facts and
// a menu item's declared figures are one current row each, version-checked, changed in one
// transaction with an audit row naming the changed fields only (never values). Nothing here is
// history: labels are worked out on read, and no sent item depends on them.

const PERMISSION = "recipes.edit";
const LIMIT = "1000000";

function cleanFigure(figure: NutritionFigure, value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  let scaled: string;

  try {
    scaled = toScale(value.trim(), 4);
  } catch {
    throw new BusinessRuleError("INVALID_NUTRITION", `${figure} must be a number with at most four decimal places.`);
  }

  if (compareDecimals(scaled, "0") < 0 || compareDecimals(scaled, LIMIT) >= 0) {
    throw new BusinessRuleError("INVALID_NUTRITION", `${figure} must be zero or more, and below ${LIMIT}.`);
  }

  return scaled;
}

function cleanValues(values: Partial<Record<NutritionFigure, string | null>>): NutritionValues {
  return Object.fromEntries(NUTRITION_FIGURES.map((figure) => [figure, cleanFigure(figure, values[figure] ?? null)])) as NutritionValues;
}

function changedFields(before: Record<string, unknown> | null, after: Record<string, string | null>): string[] {
  return Object.keys(after).filter((key) => (before?.[key] ?? null) !== after[key]);
}

function assertVersion(current: { version: number } | undefined, expected: number | null, label: string, id: string) {
  if ((current === undefined && expected !== null) || (current !== undefined && current.version !== expected)) {
    throw new ConcurrencyError(label, id);
  }
}

/** Sets an ingredient's nutrition per `basisQuantity` of its base unit. */
export async function setIngredientNutrition(
  database: Database,
  actor: Actor,
  input: {
    inventoryItemId: string;
    basisQuantity: string;
    values: Partial<Record<NutritionFigure, string | null>>;
    expectedVersion: number | null;
  },
) {
  assertPermission(actor, PERMISSION);

  const basisQuantity = cleanFigure("calories", input.basisQuantity);

  if (basisQuantity === null || compareDecimals(basisQuantity, "0") <= 0) {
    throw new BusinessRuleError("INVALID_BASIS", "Give the amount the figures are for, more than zero.");
  }

  const values = cleanValues(input.values);

  try {
    return await withTransaction(database, async (transaction) => {
      const [item] = await transaction
        .select({ id: inventoryItems.id, code: inventoryItems.code })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, input.inventoryItemId), eq(inventoryItems.organizationId, actor.organizationId)));

      if (!item) {
        throw new NotFoundError("inventory item");
      }

      const [current] = await transaction
        .select()
        .from(inventoryItemNutrition)
        .where(eq(inventoryItemNutrition.inventoryItemId, item.id))
        .for("update");

      assertVersion(current, input.expectedVersion, "ingredient nutrition", item.id);

      const now = new Date();
      const [row] = current
        ? await transaction
            .update(inventoryItemNutrition)
            .set({ basisQuantity, ...values, updatedByUserId: actor.userId, updatedAt: now, version: sql`${inventoryItemNutrition.version} + 1` })
            .where(eq(inventoryItemNutrition.id, current.id))
            .returning()
        : await transaction
            .insert(inventoryItemNutrition)
            .values({ organizationId: actor.organizationId, inventoryItemId: item.id, basisQuantity, ...values, updatedByUserId: actor.userId })
            .returning();

      await recordAudit(transaction, actor, {
        action: "recipes.ingredient-nutrition-changed",
        entityId: item.id,
        details: { itemCode: item.code, changedFields: changedFields(current ?? null, { basisQuantity, ...values }) },
      });

      return { inventoryItemId: item.id, version: row!.version };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConcurrencyError("ingredient nutrition", input.inventoryItemId);
    }

    throw error;
  }
}

/** Sets (or, with `remove`, clears) a menu item's declared nutrition per portion. */
export async function setMenuItemNutrition(
  database: Database,
  actor: Actor,
  input: {
    menuItemId: string;
    values: Partial<Record<NutritionFigure, string | null>>;
    remove?: boolean;
    expectedVersion: number | null;
  },
) {
  assertPermission(actor, PERMISSION);

  const values = cleanValues(input.values);

  try {
    return await withTransaction(database, async (transaction) => {
      const [item] = await transaction
        .select({ id: menuItems.id, code: menuItems.code })
        .from(menuItems)
        .where(and(eq(menuItems.id, input.menuItemId), eq(menuItems.organizationId, actor.organizationId)));

      if (!item) {
        throw new NotFoundError("menu item");
      }

      const [current] = await transaction
        .select()
        .from(menuItemNutrition)
        .where(eq(menuItemNutrition.menuItemId, item.id))
        .for("update");

      assertVersion(current, input.expectedVersion, "menu item nutrition", item.id);

      if (input.remove) {
        if (current) {
          await transaction.delete(menuItemNutrition).where(eq(menuItemNutrition.id, current.id));
          await recordAudit(transaction, actor, {
            action: "recipes.menu-item-nutrition-changed",
            entityId: item.id,
            details: { itemCode: item.code, changedFields: [], removed: true },
          });
        }

        return { menuItemId: item.id, version: null };
      }

      const now = new Date();
      const [row] = current
        ? await transaction
            .update(menuItemNutrition)
            .set({ ...values, updatedByUserId: actor.userId, updatedAt: now, version: sql`${menuItemNutrition.version} + 1` })
            .where(eq(menuItemNutrition.id, current.id))
            .returning()
        : await transaction
            .insert(menuItemNutrition)
            .values({ organizationId: actor.organizationId, menuItemId: item.id, ...values, updatedByUserId: actor.userId })
            .returning();

      await recordAudit(transaction, actor, {
        action: "recipes.menu-item-nutrition-changed",
        entityId: item.id,
        details: { itemCode: item.code, changedFields: changedFields(current ?? null, values), removed: false },
      });

      return { menuItemId: item.id, version: row!.version };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConcurrencyError("menu item nutrition", input.menuItemId);
    }

    throw error;
  }
}
