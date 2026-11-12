import { asc, inArray } from "drizzle-orm";

import { orderItemAllergens, orderItemModifiers } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { loadModifierEffectsForItem } from "@/modules/menu/queries/order-menu-facts";
import { loadAllergenLabels } from "@/modules/recipes/queries/allergen-facts";
import {
  describeConflict,
  findAllergenConflicts,
  type AllergenConflict,
  type AllergenKind,
  type AllergenLabel,
} from "@/modules/recipes/rules/allergen-label";
import { applyModifierEffects } from "@/modules/recipes/rules/modifier-recipe-effects";
import { resolveRevisionRequirements } from "@/modules/recipes/services/ingredient-service";
import { resolveEffectiveRevisionForMenuItem } from "@/modules/recipes/services/recipe-service";

import { loadOrderAllergies, type OrderAllergies } from "../services/order-allergy-service";

// Phase 21 (policies 11-13): what the order screen shows. A draft's label is worked out the way
// SEND will work it out (recipe in effect now, then the chosen modifiers' effects); a sent item's
// comes from its snapshot, never the current recipe (rule 4).

export type DraftLine = { id: string; menuItemId: string; modifierIds: readonly string[] };

/** The inventory items left after each draft's recipe and modifiers, as SEND would compute them. */
export async function resolveDraftIngredients(
  executor: DatabaseExecutor,
  organizationId: string,
  lines: readonly DraftLine[],
  at: Date,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  for (const line of lines) {
    const revision = await resolveEffectiveRevisionForMenuItem(executor, organizationId, line.menuItemId, at);
    const requirements = revision ? await resolveRevisionRequirements(executor, organizationId, revision.id) : [];
    const effects = await loadModifierEffectsForItem(executor, organizationId, line.menuItemId, line.modifierIds);

    result.set(line.id, applyModifierEffects(requirements, effects).map((entry) => entry.inventoryItemId));
  }

  return result;
}

export type ItemAllergenView = {
  label: AllergenLabel;
  /** Drafts: a conflict with the order's allergies. Sent items: the one acknowledged at SEND. */
  conflict: (AllergenConflict & { description: string }) | null;
  acknowledged: { at: string; description: string } | null;
};

type ItemFacts = {
  id: string;
  status: string;
  menuItemId: string;
  allergenLabelIncompleteSnapshot: boolean | null;
  allergyAcknowledgedAt: Date | null;
  allergyConflictSnapshot: string | null;
};

export async function loadOrderAllergenView(
  executor: DatabaseExecutor,
  organizationId: string,
  order: { id: string; guestPartyId: string | null; tableSessionId: string | null },
  items: readonly ItemFacts[],
): Promise<{ allergies: OrderAllergies; items: Map<string, ItemAllergenView> }> {
  const allergies = await loadOrderAllergies(executor, order);
  const drafts = items.filter((item) => item.status === "DRAFT");
  const sent = items.filter((item) => item.status !== "DRAFT");
  const result = new Map<string, ItemAllergenView>();

  if (drafts.length > 0) {
    const selections = await executor
      .select({ orderItemId: orderItemModifiers.orderItemId, modifierId: orderItemModifiers.modifierId })
      .from(orderItemModifiers)
      .where(inArray(orderItemModifiers.orderItemId, drafts.map((item) => item.id)));
    const ingredients = await resolveDraftIngredients(
      executor,
      organizationId,
      drafts.map((item) => ({
        id: item.id,
        menuItemId: item.menuItemId,
        modifierIds: selections.filter((row) => row.orderItemId === item.id).map((row) => row.modifierId),
      })),
      new Date(),
    );
    const labels = await loadAllergenLabels(
      executor,
      organizationId,
      drafts.map((item) => ({ key: item.id, menuItemId: item.menuItemId, ingredientIds: ingredients.get(item.id) ?? [] })),
    );
    const conflicts = new Map(
      findAllergenConflicts(
        drafts.map((item) => ({ itemId: item.id, label: labels.get(item.id)! })),
        allergies.allergies,
      ).map((conflict) => [conflict.itemId, conflict]),
    );

    for (const item of drafts) {
      const conflict = conflicts.get(item.id);

      result.set(item.id, {
        label: labels.get(item.id)!,
        conflict: conflict ? { ...conflict, description: describeConflict(conflict, allergies.allergies) } : null,
        acknowledged: null,
      });
    }
  }

  if (sent.length > 0) {
    const rows = await executor
      .select()
      .from(orderItemAllergens)
      .where(inArray(orderItemAllergens.orderItemId, sent.map((item) => item.id)))
      .orderBy(asc(orderItemAllergens.allergenNameSnapshot));

    for (const item of sent) {
      result.set(item.id, {
        label: {
          allergens: rows
            .filter((row) => row.orderItemId === item.id)
            .map((row) => ({
              id: row.allergenId,
              code: row.allergenCodeSnapshot,
              name: row.allergenNameSnapshot,
              kind: row.kind as AllergenKind,
              source: row.source as "DERIVED" | "DECLARED",
            })),
          // Items sent before Phase 21 have no snapshot: shown as incomplete, never as none.
          incomplete: item.allergenLabelIncompleteSnapshot ?? true,
        },
        conflict: null,
        acknowledged:
          item.allergyAcknowledgedAt && item.allergyConflictSnapshot
            ? { at: item.allergyAcknowledgedAt.toISOString(), description: item.allergyConflictSnapshot }
            : null,
      });
    }
  }

  return { allergies, items: result };
}
