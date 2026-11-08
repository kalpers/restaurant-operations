import { z } from "zod";

import {
  addDecimals,
  compareDecimals,
  isDecimalString,
  isPositiveDecimal,
  significantScale,
} from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// How a modifier changes a Menu Item's recipe requirements (approved Phase 8 semantics):
//   ADD     a positive quantity of an Inventory Item is added.
//   REMOVE  the Menu Item recipe's requirement for that Inventory Item is dropped entirely.
//   ADJUST  the existing requirement changes by a signed, non-zero quantity.
// A substitution is a REMOVE of one item plus an ADD of another. Every effect belongs to one
// Menu Item, because quantities differ between products. A preparation-only effect is a
// different kind and never becomes an ingredient change. Saving an effect moves no stock.

const exactQuantity = (positiveOnly: boolean) =>
  z
    .string()
    .refine(
      (value) =>
        isDecimalString(value) &&
        significantScale(value) <= 4 &&
        compareDecimals(value, "0") !== 0 &&
        (!positiveOnly || isPositiveDecimal(value)),
      positiveOnly
        ? "Quantity must be a positive decimal string with at most four decimal places."
        : "Quantity must be a non-zero decimal string with at most four decimal places.",
    );

const ingredientBase = {
  kind: z.literal("INGREDIENT"),
  menuItemId: z.uuid(),
  inventoryItemId: z.uuid(),
};

export const ingredientEffectSchema = z.discriminatedUnion("operation", [
  z.object({
    ...ingredientBase,
    operation: z.literal("ADD"),
    quantity: exactQuantity(true),
    unitOfMeasureId: z.uuid(),
  }),
  z.object({ ...ingredientBase, operation: z.literal("REMOVE") }),
  z.object({
    ...ingredientBase,
    operation: z.literal("ADJUST"),
    quantity: exactQuantity(false),
    unitOfMeasureId: z.uuid(),
  }),
]);

export const preparationEffectSchema = z.object({
  kind: z.literal("PREPARATION"),
  instruction: z.string().trim().min(1).max(500),
});

export const modifierRecipeEffectSchema = z.union([
  ingredientEffectSchema,
  preparationEffectSchema,
]);

export type IngredientEffect = z.output<typeof ingredientEffectSchema>;
export type PreparationEffect = z.output<typeof preparationEffectSchema>;
export type ModifierRecipeEffect = z.output<typeof modifierRecipeEffectSchema>;

/** A swap, expressed as the two effects that make it: REMOVE the old item, ADD the new. */
export function buildSubstitution(input: {
  menuItemId: string;
  removedInventoryItemId: string;
  added: { inventoryItemId: string; quantity: string; unitOfMeasureId: string };
}): [IngredientEffect, IngredientEffect] {
  if (input.removedInventoryItemId === input.added.inventoryItemId) {
    throw new BusinessRuleError(
      "INVALID_SUBSTITUTION",
      "A substitution must replace one item with a different one.",
    );
  }

  return [
    ingredientEffectSchema.parse({
      kind: "INGREDIENT",
      operation: "REMOVE",
      menuItemId: input.menuItemId,
      inventoryItemId: input.removedInventoryItemId,
    }),
    ingredientEffectSchema.parse({
      kind: "INGREDIENT",
      operation: "ADD",
      menuItemId: input.menuItemId,
      ...input.added,
    }),
  ];
}

/** Validates a modifier's effect list: shape, and no item changed twice for one Menu Item. */
export function parseModifierRecipeEffects(input: unknown): ModifierRecipeEffect[] {
  const parsed = z.array(modifierRecipeEffectSchema).safeParse(input);

  if (!parsed.success) {
    throw new BusinessRuleError(
      "INVALID_RECIPE_EFFECT",
      "A recipe effect is malformed: check the operation, item and quantity.",
    );
  }

  const seen = new Set<string>();

  for (const effect of parsed.data) {
    if (effect.kind !== "INGREDIENT") {
      continue;
    }

    const key = `${effect.menuItemId}:${effect.inventoryItemId}`;

    if (seen.has(key)) {
      throw new BusinessRuleError(
        "DUPLICATE_RECIPE_EFFECT",
        "An item can only be changed once by a modifier on one menu item.",
      );
    }

    seen.add(key);
  }

  return parsed.data;
}

/** One ingredient requirement, already converted to the Inventory Item's base unit. */
export type Requirement = { inventoryItemId: string; baseQuantity: string };

/** An ingredient effect with its quantity already converted to base units. */
export type BaseEffect =
  | { operation: "ADD" | "ADJUST"; inventoryItemId: string; baseQuantity: string }
  | { operation: "REMOVE"; inventoryItemId: string };

/**
 * Applies modifier effects to a Menu Item's recipe requirements, for Phase 9 to compute
 * consumption once at SEND. ADD merges with an existing requirement. REMOVE drops it (a
 * no-op if the recipe no longer has it). ADJUST changes an existing requirement and is a
 * no-op if the recipe no longer has it; a result at or below zero drops the requirement,
 * because nothing can be consumed in a negative amount. Order of effects doesn't matter
 * except that REMOVE wins over ADJUST for the same item.
 */
export function applyModifierEffects(
  requirements: readonly Requirement[],
  effects: readonly BaseEffect[],
): Requirement[] {
  const result = new Map(requirements.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));
  const removed = new Set(
    effects.filter((effect) => effect.operation === "REMOVE").map((effect) => effect.inventoryItemId),
  );

  for (const effect of effects) {
    if (effect.operation === "REMOVE" || removed.has(effect.inventoryItemId)) {
      continue;
    }

    const current = result.get(effect.inventoryItemId);

    if (effect.operation === "ADD") {
      result.set(
        effect.inventoryItemId,
        current === undefined ? effect.baseQuantity : addDecimals(current, effect.baseQuantity),
      );
    } else if (current !== undefined) {
      result.set(effect.inventoryItemId, addDecimals(current, effect.baseQuantity));
    }
  }

  for (const id of removed) {
    result.delete(id);
  }

  return [...result.entries()]
    .filter(([, quantity]) => compareDecimals(quantity, "0") > 0)
    .map(([inventoryItemId, baseQuantity]) => ({ inventoryItemId, baseQuantity }));
}
