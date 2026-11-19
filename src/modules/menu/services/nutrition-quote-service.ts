import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { loadNutritionLabels } from "@/modules/recipes/queries/nutrition-facts";
import { applyModifierEffects } from "@/modules/recipes/rules/modifier-recipe-effects";
import type { NutritionLabel } from "@/modules/recipes/rules/nutrition-label";
import { resolveRevisionRequirements } from "@/modules/recipes/services/ingredient-service";
import { resolveEffectiveRevisionForMenuItem } from "@/modules/recipes/services/recipe-service";

import { loadModifierEffectsForItem } from "../queries/order-menu-facts";
import { assertValidSelection, type ProposedSelection } from "../rules/modifier-selection";
import { assertPermission, requireMenuItem } from "./access";
import { loadSelectionGroups } from "./selection-service";

// Phase 28 (policies 12 and 16): the nutrition of one item with these modifiers, for the order
// screen. One portion is the recipe in effect now with the chosen modifiers' ingredient effects
// applied, exactly as SEND resolves consumption. A quote: nothing is stored.

export async function quoteNutrition(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { menuItemId: string; selections: readonly ProposedSelection[]; at?: Date },
): Promise<NutritionLabel> {
  assertPermission(actor, "menu.view");
  await requireMenuItem(executor, actor, input.menuItemId);

  const { groups } = await loadSelectionGroups(executor, actor.organizationId, input.menuItemId);

  assertValidSelection(groups, input.selections);

  const at = input.at ?? new Date();
  const revision = await resolveEffectiveRevisionForMenuItem(executor, actor.organizationId, input.menuItemId, at);
  const requirements = revision ? await resolveRevisionRequirements(executor, actor.organizationId, revision.id) : null;
  const effects = await loadModifierEffectsForItem(
    executor,
    actor.organizationId,
    input.menuItemId,
    input.selections.map((selection) => selection.modifierId),
  );
  const portion = requirements === null && effects.length === 0 ? null : applyModifierEffects(requirements ?? [], effects);
  const labels = await loadNutritionLabels(executor, actor.organizationId, [
    { key: input.menuItemId, menuItemId: input.menuItemId, requirements: portion },
  ]);

  return labels.get(input.menuItemId)!;
}
