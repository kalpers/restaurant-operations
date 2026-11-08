import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItems,
  menuItemModifierGroups,
  menuItems,
  modifierGroupModifiers,
  modifierInventoryEffects,
  modifiers,
  unitsOfMeasure,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  getInventoryItemFacts,
  toItemBaseQuantity,
} from "@/modules/inventory/queries/item-facts";
import { parseModifierRecipeEffects } from "@/modules/recipes/rules/modifier-recipe-effects";
import { listIngredients } from "@/modules/recipes/services/ingredient-service";
import { resolveEffectiveRevisionForMenuItem } from "@/modules/recipes/services/recipe-service";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertPermission } from "./access";

// A modifier's effect on one Menu Item's recipe requirements, bound to a real Inventory Item.
// Configuration only: saving an effect never posts stock. ADD carries a positive quantity,
// REMOVE none, ADJUST a signed non-zero one. REMOVE and ADJUST must name an ingredient of the
// Menu Item's recipe revision in effect now; Phase 9 re-resolves at SEND.

export type EffectInput = {
  menuItemId: string;
  inventoryItemId: string;
  effectType: "ADD" | "REMOVE" | "ADJUST";
  quantity: string | null;
  unitOfMeasureId: string | null;
};

export async function listModifierEffects(
  executor: DatabaseExecutor,
  actor: Actor,
  modifierId: string,
) {
  assertPermission(actor, "menu.view");

  return executor
    .select({
      effect: modifierInventoryEffects,
      menuItemName: menuItems.name,
      inventoryItemName: inventoryItems.name,
      unitCode: unitsOfMeasure.code,
    })
    .from(modifierInventoryEffects)
    .innerJoin(menuItems, eq(menuItems.id, modifierInventoryEffects.menuItemId))
    .innerJoin(inventoryItems, eq(inventoryItems.id, modifierInventoryEffects.inventoryItemId))
    .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, modifierInventoryEffects.unitOfMeasureId))
    .where(
      and(
        eq(modifierInventoryEffects.modifierId, modifierId),
        eq(modifierInventoryEffects.organizationId, actor.organizationId),
      ),
    )
    .orderBy(asc(menuItems.name), asc(inventoryItems.name))
    .then((rows) =>
      rows.map(({ effect, menuItemName, inventoryItemName, unitCode }) => ({
        ...effect,
        menuItemName,
        inventoryItemName,
        unitCode,
      })),
    );
}

async function validateEffect(
  executor: DatabaseExecutor,
  actor: Actor,
  modifierId: string,
  input: EffectInput,
) {
  // Shape, through the one contract.
  parseModifierRecipeEffects([
    {
      kind: "INGREDIENT",
      operation: input.effectType,
      menuItemId: input.menuItemId,
      inventoryItemId: input.inventoryItemId,
      ...(input.effectType === "REMOVE"
        ? {}
        : { quantity: input.quantity ?? undefined, unitOfMeasureId: input.unitOfMeasureId ?? undefined }),
    },
  ]);

  if (input.effectType === "REMOVE" && (input.quantity !== null || input.unitOfMeasureId !== null)) {
    throw new BusinessRuleError("INVALID_RECIPE_EFFECT", "A REMOVE effect has no quantity.");
  }

  const [modifier] = await executor
    .select({ id: modifiers.id })
    .from(modifiers)
    .where(and(eq(modifiers.id, modifierId), eq(modifiers.organizationId, actor.organizationId)));

  if (!modifier) {
    throw new NotFoundError("modifier");
  }

  // The modifier must actually be offered on this Menu Item.
  const [offered] = await executor
    .select({ id: menuItemModifierGroups.id })
    .from(menuItemModifierGroups)
    .innerJoin(
      modifierGroupModifiers,
      eq(modifierGroupModifiers.modifierGroupId, menuItemModifierGroups.modifierGroupId),
    )
    .where(
      and(
        eq(menuItemModifierGroups.menuItemId, input.menuItemId),
        eq(menuItemModifierGroups.organizationId, actor.organizationId),
        eq(modifierGroupModifiers.modifierId, modifierId),
      ),
    )
    .limit(1);

  if (!offered) {
    throw new BusinessRuleError(
      "MODIFIER_NOT_ON_ITEM",
      "That modifier isn't offered on that menu item. Attach a group that holds it first.",
    );
  }

  const item = await getInventoryItemFacts(executor, actor.organizationId, input.inventoryItemId);

  if (!item) {
    throw new NotFoundError("inventory item");
  }

  if (!item.active) {
    throw new BusinessRuleError("ITEM_INACTIVE", "That inventory item is inactive.");
  }

  if (input.effectType !== "REMOVE") {
    const magnitude = input.quantity!.startsWith("-") ? input.quantity!.slice(1) : input.quantity!;

    await toItemBaseQuantity(executor, item, magnitude, input.unitOfMeasureId!);
  }

  if (input.effectType !== "ADD") {
    const revision = await resolveEffectiveRevisionForMenuItem(
      executor,
      actor.organizationId,
      input.menuItemId,
      new Date(),
    );
    const ingredients = revision ? await listIngredients(executor, [revision.id]) : [];

    if (!ingredients.some((row) => row.inventoryItemId === input.inventoryItemId)) {
      throw new BusinessRuleError(
        "NOT_A_RECIPE_INGREDIENT",
        "REMOVE and ADJUST need an ingredient of the menu item's current recipe.",
      );
    }
  }
}

export async function addModifierEffect(
  database: Database,
  actor: Actor,
  modifierId: string,
  input: EffectInput,
) {
  assertPermission(actor, "menu.modifiers.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      await validateEffect(transaction, actor, modifierId, input);

      const [row] = await transaction
        .insert(modifierInventoryEffects)
        .values({ ...input, modifierId, organizationId: actor.organizationId })
        .returning();

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "EFFECT_EXISTS",
        "This modifier already changes that item on that menu item. Edit that effect instead.",
      );
    }

    throw error;
  }
}

export async function updateModifierEffect(
  database: Database,
  actor: Actor,
  modifierId: string,
  effectId: string,
  input: Omit<EffectInput, "menuItemId" | "inventoryItemId"> & { expectedVersion: number },
) {
  assertPermission(actor, "menu.modifiers.manage");

  return withTransaction(database, async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(modifierInventoryEffects)
      .where(
        and(
          eq(modifierInventoryEffects.id, effectId),
          eq(modifierInventoryEffects.modifierId, modifierId),
          eq(modifierInventoryEffects.organizationId, actor.organizationId),
        ),
      );

    if (!existing) {
      throw new NotFoundError("modifier effect");
    }

    await validateEffect(transaction, actor, modifierId, {
      ...input,
      menuItemId: existing.menuItemId,
      inventoryItemId: existing.inventoryItemId,
    });

    const rows = await transaction
      .update(modifierInventoryEffects)
      .set({
        effectType: input.effectType,
        quantity: input.quantity,
        unitOfMeasureId: input.unitOfMeasureId,
        version: nextVersion(modifierInventoryEffects.version),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(modifierInventoryEffects.id, effectId),
          eq(modifierInventoryEffects.version, input.expectedVersion),
        ),
      )
      .returning();

    if (!rows[0]) {
      throw new ConcurrencyError("modifier effect", effectId);
    }

    return rows[0];
  });
}

/** Effects are configuration, not history: Phase 9 snapshots what was consumed. */
export async function removeModifierEffect(
  database: Database,
  actor: Actor,
  modifierId: string,
  effectId: string,
) {
  assertPermission(actor, "menu.modifiers.manage");

  const removed = await database
    .delete(modifierInventoryEffects)
    .where(
      and(
        eq(modifierInventoryEffects.id, effectId),
        eq(modifierInventoryEffects.modifierId, modifierId),
        eq(modifierInventoryEffects.organizationId, actor.organizationId),
      ),
    )
    .returning({ id: modifierInventoryEffects.id });

  if (removed.length === 0) {
    throw new NotFoundError("modifier effect");
  }
}
