import { z } from "zod";

import { isDecimalString, isPositiveDecimal, significantScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Typed contracts for the ingredient changes a modifier will make once Phase 8 stores
// Recipe ingredients. Nothing here is persisted and nothing checks that an Inventory Item
// exists or that units are compatible: Phase 8 owns that. Quantities are positive exact
// decimal strings, and the operation (not a sign) gives the direction. A substitution is a
// REMOVE of one item plus an ADD of another. A preparation-only effect is a different kind
// and never becomes an ingredient delta.

const positiveQuantity = z
  .string()
  .refine(
    (value) =>
      isDecimalString(value) && isPositiveDecimal(value) && significantScale(value) <= 4,
    "Quantity must be a positive decimal string with at most four decimal places.",
  );

const ingredientBase = {
  kind: z.literal("INGREDIENT"),
  inventoryItemId: z.uuid(),
  quantity: positiveQuantity,
  unitOfMeasureId: z.uuid(),
  /** Optional Menu Item context, for modifiers whose quantities differ by product. */
  menuItemId: z.uuid().nullable().default(null),
};

export const ingredientEffectSchema = z.discriminatedUnion("operation", [
  z.object({ ...ingredientBase, operation: z.literal("ADD") }),
  z.object({ ...ingredientBase, operation: z.literal("REMOVE") }),
  z.object({
    ...ingredientBase,
    operation: z.literal("ADJUST"),
    direction: z.enum(["INCREASE", "DECREASE"]),
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
  removed: { inventoryItemId: string; quantity: string; unitOfMeasureId: string };
  added: { inventoryItemId: string; quantity: string; unitOfMeasureId: string };
  menuItemId?: string | null;
}): [IngredientEffect, IngredientEffect] {
  if (input.removed.inventoryItemId === input.added.inventoryItemId) {
    throw new BusinessRuleError(
      "INVALID_SUBSTITUTION",
      "A substitution must replace one item with a different one.",
    );
  }

  const menuItemId = input.menuItemId ?? null;

  return [
    ingredientEffectSchema.parse({
      kind: "INGREDIENT",
      operation: "REMOVE",
      menuItemId,
      ...input.removed,
    }),
    ingredientEffectSchema.parse({
      kind: "INGREDIENT",
      operation: "ADD",
      menuItemId,
      ...input.added,
    }),
  ];
}

/** Validates a modifier's effect list: shape, and no item changed twice in one context. */
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

    const key = `${effect.menuItemId ?? "*"}:${effect.inventoryItemId}`;

    if (seen.has(key)) {
      throw new BusinessRuleError(
        "DUPLICATE_RECIPE_EFFECT",
        "An item can only be changed once by a modifier. Combine the quantities.",
      );
    }

    seen.add(key);
  }

  return parsed.data;
}

export type IngredientDelta = {
  inventoryItemId: string;
  quantity: string;
  unitOfMeasureId: string;
  menuItemId: string | null;
  direction: "ADD" | "REMOVE";
};

/**
 * The future consumption requirements: only ingredient effects, never preparation text.
 * ADJUST maps to ADD (increase) or REMOVE (decrease).
 */
export function ingredientDeltasOf(effects: readonly ModifierRecipeEffect[]): IngredientDelta[] {
  return effects.flatMap((effect) => {
    if (effect.kind !== "INGREDIENT") {
      return [];
    }

    const direction =
      effect.operation === "ADJUST"
        ? effect.direction === "INCREASE"
          ? "ADD"
          : "REMOVE"
        : effect.operation;

    return [
      {
        inventoryItemId: effect.inventoryItemId,
        quantity: effect.quantity,
        unitOfMeasureId: effect.unitOfMeasureId,
        menuItemId: effect.menuItemId,
        direction,
      },
    ];
  });
}
