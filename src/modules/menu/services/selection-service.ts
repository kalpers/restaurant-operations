import { and, asc, eq, inArray } from "drizzle-orm";

import {
  menuItemModifierGroups,
  menuItems,
  modifierGroupModifiers,
  modifierGroups,
  modifiers,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { calculateItemAmount } from "../rules/modifier-pricing";
import {
  assertValidSelection,
  effectiveConstraints,
  validateSelection,
  type ProposedSelection,
  type SelectionGroup,
  type SelectionType,
  type SelectionViolation,
} from "../rules/modifier-selection";
import { assertPermission } from "./access";
import { resolveMenuItemPrice } from "./pricing-service";

/**
 * The groups, rules and choices that apply to one item, ready for the pure validator.
 * A group counts as active only if both the group and its attachment to this item are;
 * a choice counts only if the modifier and its place in the group are.
 */
export async function loadSelectionGroups(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemId: string,
): Promise<{ groups: SelectionGroup[]; priceAdjustments: Map<string, string> }> {
  const attachments = await executor
    .select({ attachment: menuItemModifierGroups, group: modifierGroups })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.modifierGroupId))
    .where(
      and(
        eq(menuItemModifierGroups.menuItemId, menuItemId),
        eq(menuItemModifierGroups.organizationId, organizationId),
      ),
    )
    .orderBy(asc(menuItemModifierGroups.displayOrder));
  const groupIds = attachments.map(({ group }) => group.id);
  const members =
    groupIds.length === 0
      ? []
      : await executor
          .select({
            membership: modifierGroupModifiers,
            modifier: modifiers,
          })
          .from(modifierGroupModifiers)
          .innerJoin(modifiers, eq(modifiers.id, modifierGroupModifiers.modifierId))
          .where(inArray(modifierGroupModifiers.modifierGroupId, groupIds))
          .orderBy(asc(modifierGroupModifiers.displayOrder));
  const priceAdjustments = new Map<string, string>();

  for (const { modifier } of members) {
    priceAdjustments.set(modifier.id, modifier.priceAdjustment);
  }

  return {
    priceAdjustments,
    groups: attachments.map(({ attachment, group }) => ({
      modifierGroupId: group.id,
      name: group.name,
      active: attachment.active && group.active,
      constraints: effectiveConstraints(
        { ...group, selectionType: group.selectionType as SelectionType },
        attachment,
      ),
      modifiers: members
        .filter(({ membership }) => membership.modifierGroupId === group.id)
        .map(({ membership, modifier }) => ({
          modifierId: modifier.id,
          name: modifier.name,
          active: membership.active && modifier.active,
        })),
    })),
  };
}

async function requireOwnedItem(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
) {
  const [item] = await executor
    .select({ id: menuItems.id, active: menuItems.active, available: menuItems.available })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }

  return item;
}

/** Every rule a proposed selection breaks. Empty means it is valid. */
export async function validateModifierSelection(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { menuItemId: string; selections: readonly ProposedSelection[] },
): Promise<SelectionViolation[]> {
  assertPermission(actor, "menu.view");
  await requireOwnedItem(executor, actor, input.menuItemId);

  const { groups } = await loadSelectionGroups(executor, actor.organizationId, input.menuItemId);

  return validateSelection(groups, input.selections);
}

export type ProspectiveItemPrice = {
  basePrice: string;
  priceScope: "LOCATION" | "ORGANIZATION";
  modifiers: { modifierId: string; priceAdjustment: string }[];
  amount: string;
};

/**
 * What one item with these modifiers would cost at an instant: the resolved base price
 * plus each chosen modifier's adjustment, after the selection passes validation. This is
 * a quote, not an order: there is no tax, discount or total, and nothing is stored.
 */
export async function priceProspectiveItem(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    menuItemId: string;
    selections: readonly ProposedSelection[];
    locationId?: string;
    at?: Date;
  },
): Promise<ProspectiveItemPrice> {
  assertPermission(actor, "menu.view");

  const item = await requireOwnedItem(executor, actor, input.menuItemId);

  if (!item.active || !item.available) {
    throw new BusinessRuleError("ITEM_UNAVAILABLE", "That item isn't available.");
  }

  const price = await resolveMenuItemPrice(
    executor,
    actor.organizationId,
    input.menuItemId,
    input.locationId ?? actor.locationId,
    input.at ?? new Date(),
  );

  if (!price) {
    throw new BusinessRuleError("NO_PRICE", "That item has no price in effect.");
  }

  const { groups, priceAdjustments } = await loadSelectionGroups(
    executor,
    actor.organizationId,
    input.menuItemId,
  );

  assertValidSelection(groups, input.selections);

  const chosen = input.selections.map((selection) => ({
    modifierId: selection.modifierId,
    priceAdjustment: priceAdjustments.get(selection.modifierId) ?? "0.00",
  }));

  return {
    basePrice: price.price,
    priceScope: price.scope,
    modifiers: chosen,
    amount: calculateItemAmount(
      price.price,
      chosen.map((entry) => entry.priceAdjustment),
    ),
  };
}
