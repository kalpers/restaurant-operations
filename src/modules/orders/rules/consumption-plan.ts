import {
  applyModifierEffects,
  type BaseEffect,
  type Requirement,
} from "@/modules/recipes/rules/modifier-recipe-effects";
import { multiplyDecimals } from "@/shared/decimal/decimal";

const QUANTITY_SCALE = 4;

export type PlannedConsumption = {
  inventoryItemId: string;
  /** Per unit sold, after modifier effects. */
  perUnitBaseQuantity: string;
  /** For the whole line. */
  baseQuantity: string;
  /** The recipe revision's own per-unit requirement, or null if a modifier ADDed it. */
  recipeBaseQuantity: string | null;
  effects: BaseEffect[];
};

/**
 * One line's consumption, computed once at SEND. It takes the recipe revision's base-unit
 * requirements and applies the selected modifiers' effects using the shared Phase 8 rule,
 * `applyModifierEffects`: ADD merges, REMOVE drops and wins over ADJUST, and a result at
 * or below zero is dropped, so nothing is ever consumed in a negative amount. The result
 * is multiplied by the quantity. An item with no recipe and no ADD effects consumes nothing.
 */
export function planLineConsumption(input: {
  requirements: readonly Requirement[];
  effects: readonly BaseEffect[];
  quantity: number;
}): PlannedConsumption[] {
  const recipeById = new Map(
    input.requirements.map((entry) => [entry.inventoryItemId, entry.baseQuantity]),
  );
  const net = applyModifierEffects(input.requirements, input.effects);

  return net
    .map((entry) => ({
      inventoryItemId: entry.inventoryItemId,
      perUnitBaseQuantity: entry.baseQuantity,
      baseQuantity: multiplyDecimals(entry.baseQuantity, String(input.quantity), QUANTITY_SCALE),
      recipeBaseQuantity: recipeById.get(entry.inventoryItemId) ?? null,
      effects: input.effects.filter((effect) => effect.inventoryItemId === entry.inventoryItemId),
    }))
    .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
}
