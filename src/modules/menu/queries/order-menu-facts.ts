import { and, eq, inArray } from "drizzle-orm";

import { inventoryItems, modifierInventoryEffects } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { toItemBaseQuantity } from "@/modules/inventory/queries/item-facts";
import type { BaseEffect } from "@/modules/recipes/rules/modifier-recipe-effects";
import { BusinessRuleError } from "@/shared/errors/app-error";

import type { ProposedSelection } from "../rules/modifier-selection";
import { assertValidSelection } from "../rules/modifier-selection";
import { loadSelectionGroups } from "../services/selection-service";
import { loadModifierOutagesInEffect } from "./stock-signals";
import {
  getOperationalMenu,
  type OperationalMenu,
  type OperationalMenuItem,
  type OperationalModifier,
} from "./operational-menu";

// What Order entry reads from the Menu domain. Sellability, price, modifier rules and prep
// routing all come from the operational menu query and the one selection validator, so
// Orders never re-implement price precedence or selection rules.

export type SellableSelection = {
  modifierGroupId: string;
  modifierGroupName: string;
  modifier: OperationalModifier;
};

export type SellableItem = {
  item: OperationalMenuItem;
  /** Phase 20 (policy 1): the category of the placement it resolved to, snapshotted at SEND. */
  category: { id: string; name: string };
  selections: SellableSelection[];
};

/**
 * Resolves an item as sold at the actor's Location at `at`: on an open menu, active,
 * available and priced, with the selection validated by the authoritative validator.
 */
export async function resolveSellableItem(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    menuItemId: string;
    selections: readonly ProposedSelection[];
    at: Date;
    /** The operational menu at `at`, when the caller resolves several items at once. */
    menu?: OperationalMenu;
  },
): Promise<SellableItem> {
  const menu = input.menu ?? (await getOperationalMenu(executor, actor, input.at));
  let item: OperationalMenuItem | undefined;
  let category: { id: string; name: string } | undefined;

  // The first placement wins: menus in their order, then category display order.
  for (const offered of menu.menus) {
    for (const candidate of offered.categories) {
      const found = item ? undefined : candidate.items.find((entry) => entry.menuItemId === input.menuItemId);

      if (found) {
        item = found;
        category = { id: candidate.id, name: candidate.name };
      }
    }
  }

  if (!item || !category) {
    throw new BusinessRuleError("ITEM_NOT_SELLABLE", "That item isn't available to order right now.");
  }

  const { groups } = await loadSelectionGroups(executor, actor.organizationId, input.menuItemId);

  assertValidSelection(groups, input.selections);

  const selections = input.selections.map((selection) => {
    const group = item.modifierGroups.find((entry) => entry.id === selection.modifierGroupId);
    const modifier = group?.modifiers.find((entry) => entry.id === selection.modifierId);

    if (!group || !modifier) {
      return null;
    }

    return { modifierGroupId: group.id, modifierGroupName: group.name, modifier };
  });

  if (selections.some((selection) => selection === null)) {
    const outs = await loadModifierOutagesInEffect(executor, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      at: input.at,
      modifierIds: input.selections.map((selection) => selection.modifierId),
    });

    if (outs.length > 0) {
      throw new BusinessRuleError("MODIFIER_UNAVAILABLE", "A chosen modifier is 86'd here right now.");
    }

    throw new BusinessRuleError("MODIFIER_INACTIVE", "That modifier isn't available.");
  }

  return {
    item,
    category,
    selections: selections.filter((selection): selection is SellableSelection => selection !== null),
  };
}

/**
 * The selected modifiers' inventory effects for one Menu Item, converted to each Inventory
 * Item's base unit. Effects are scoped to this Menu Item, so a modifier can't move stock
 * for a product it wasn't configured for.
 */
export async function loadModifierEffectsForItem(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemId: string,
  modifierIds: readonly string[],
): Promise<(BaseEffect & { modifierId: string })[]> {
  if (modifierIds.length === 0) {
    return [];
  }

  const rows = await executor
    .select({
      modifierId: modifierInventoryEffects.modifierId,
      inventoryItemId: modifierInventoryEffects.inventoryItemId,
      effectType: modifierInventoryEffects.effectType,
      quantity: modifierInventoryEffects.quantity,
      unitOfMeasureId: modifierInventoryEffects.unitOfMeasureId,
      baseUnitId: inventoryItems.baseUnitId,
    })
    .from(modifierInventoryEffects)
    .innerJoin(inventoryItems, eq(inventoryItems.id, modifierInventoryEffects.inventoryItemId))
    .where(
      and(
        eq(modifierInventoryEffects.organizationId, organizationId),
        eq(modifierInventoryEffects.menuItemId, menuItemId),
        inArray(modifierInventoryEffects.modifierId, [...modifierIds]),
      ),
    );
  const effects: (BaseEffect & { modifierId: string })[] = [];

  for (const row of rows) {
    if (row.effectType === "REMOVE") {
      effects.push({ modifierId: row.modifierId, operation: "REMOVE", inventoryItemId: row.inventoryItemId });
      continue;
    }

    const negative = row.quantity!.startsWith("-");
    const magnitude = negative ? row.quantity!.slice(1) : row.quantity!;
    const base = await toItemBaseQuantity(
      executor,
      { id: row.inventoryItemId, baseUnitId: row.baseUnitId },
      magnitude,
      row.unitOfMeasureId!,
    );

    effects.push({
      modifierId: row.modifierId,
      operation: row.effectType as "ADD" | "ADJUST",
      inventoryItemId: row.inventoryItemId,
      baseQuantity: negative ? `-${base}` : base,
    });
  }

  return effects.sort(
    (a, b) => a.modifierId.localeCompare(b.modifierId) || a.inventoryItemId.localeCompare(b.inventoryItemId),
  );
}
