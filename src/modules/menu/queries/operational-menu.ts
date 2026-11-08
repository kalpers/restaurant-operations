import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import {
  menuAvailability,
  menuCategories,
  menuItemModifierGroups,
  menuItemPlacements,
  menuItemPrepRouting,
  menuItemPrices,
  menuItems,
  menuLocations,
  menus,
  modifierGroupModifiers,
  modifierGroups,
  modifiers,
  prepStations,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";

import { effectiveConstraints, type SelectionType } from "../rules/modifier-selection";
import { resolvePrice } from "../rules/price-resolution";
import { assertPermission } from "../services/access";

// The contract Phase 9 order entry reads. It carries what is sold and how it is chosen:
// placement, exact price, modifier groups with their effective rules, and routing IDs.
// It deliberately has no recipe, revision, cost, audit or version data.

export type OperationalModifier = {
  id: string;
  code: string;
  name: string;
  priceAdjustment: string;
  preparationEffectType: string;
  preparationInstruction: string | null;
};

export type OperationalModifierGroup = {
  id: string;
  code: string;
  name: string;
  selectionType: SelectionType;
  minimumSelections: number;
  maximumSelections: number | null;
  modifiers: OperationalModifier[];
};

export type OperationalMenuItem = {
  placementId: string;
  menuItemId: string;
  code: string;
  name: string;
  shortName: string | null;
  description: string | null;
  itemType: string;
  price: string;
  priceScope: "LOCATION" | "ORGANIZATION";
  prepStationIds: string[];
  modifierGroups: OperationalModifierGroup[];
};

export type OperationalMenu = {
  locationId: string;
  asOf: string;
  menus: {
    id: string;
    code: string;
    name: string;
    categories: {
      id: string;
      code: string;
      name: string;
      items: OperationalMenuItem[];
    }[];
  }[];
};

export async function getOperationalMenu(
  executor: DatabaseExecutor,
  actor: Actor,
  at: Date = new Date(),
): Promise<OperationalMenu> {
  assertPermission(actor, "menu.view");

  const result: OperationalMenu = {
    locationId: actor.locationId,
    asOf: at.toISOString(),
    menus: [],
  };

  const offered = await executor
    .select({ id: menus.id, code: menus.code, name: menus.name })
    .from(menus)
    .innerJoin(menuLocations, eq(menuLocations.menuId, menus.id))
    .where(
      and(
        eq(menus.organizationId, actor.organizationId),
        eq(menus.active, true),
        eq(menuLocations.locationId, actor.locationId),
        eq(menuLocations.active, true),
      ),
    )
    .orderBy(asc(menus.displayOrder), asc(menus.name));

  if (offered.length === 0) {
    return result;
  }

  // A menu with availability windows here is offered only inside one of them.
  const menuIds = offered.map((menu) => menu.id);
  const windows = await executor
    .select()
    .from(menuAvailability)
    .where(
      and(
        inArray(menuAvailability.menuId, menuIds),
        eq(menuAvailability.locationId, actor.locationId),
      ),
    );
  const openMenus = offered.filter((menu) => {
    const own = windows.filter((window) => window.menuId === menu.id);

    return (
      own.length === 0 ||
      own.some(
        (window) =>
          window.effectiveFrom <= at && (window.effectiveTo === null || at < window.effectiveTo),
      )
    );
  });

  if (openMenus.length === 0) {
    return result;
  }

  const placed = await executor
    .select({
      placementId: menuItemPlacements.id,
      placementOrder: menuItemPlacements.displayOrder,
      menuId: menuItemPlacements.menuId,
      category: menuCategories,
      item: menuItems,
    })
    .from(menuItemPlacements)
    .innerJoin(menuCategories, eq(menuCategories.id, menuItemPlacements.menuCategoryId))
    .innerJoin(menuItems, eq(menuItems.id, menuItemPlacements.menuItemId))
    .where(
      and(
        inArray(
          menuItemPlacements.menuId,
          openMenus.map((menu) => menu.id),
        ),
        eq(menuItemPlacements.active, true),
        eq(menuCategories.active, true),
        eq(menuItems.active, true),
        eq(menuItems.available, true),
      ),
    )
    .orderBy(
      asc(menuCategories.displayOrder),
      asc(menuItemPlacements.displayOrder),
      asc(menuItems.name),
    );
  const itemIds = [...new Set(placed.map((row) => row.item.id))];

  if (itemIds.length === 0) {
    result.menus = openMenus.map((menu) => ({ ...menu, categories: [] }));

    return result;
  }

  const priceRows = await executor
    .select()
    .from(menuItemPrices)
    .where(
      and(
        inArray(menuItemPrices.menuItemId, itemIds),
        or(isNull(menuItemPrices.locationId), eq(menuItemPrices.locationId, actor.locationId)),
      ),
    );
  const routing = await executor
    .select({ menuItemId: menuItemPrepRouting.menuItemId, stationId: prepStations.id })
    .from(menuItemPrepRouting)
    .innerJoin(prepStations, eq(prepStations.id, menuItemPrepRouting.prepStationId))
    .where(
      and(
        inArray(menuItemPrepRouting.menuItemId, itemIds),
        eq(menuItemPrepRouting.locationId, actor.locationId),
        eq(menuItemPrepRouting.active, true),
        eq(prepStations.active, true),
      ),
    )
    .orderBy(asc(menuItemPrepRouting.sortOrder));
  const attachments = await executor
    .select({ attachment: menuItemModifierGroups, group: modifierGroups })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.modifierGroupId))
    .where(
      and(
        inArray(menuItemModifierGroups.menuItemId, itemIds),
        eq(menuItemModifierGroups.active, true),
        eq(modifierGroups.active, true),
      ),
    )
    .orderBy(asc(menuItemModifierGroups.displayOrder));
  const groupIds = [...new Set(attachments.map(({ group }) => group.id))];
  const members =
    groupIds.length === 0
      ? []
      : await executor
          .select({ membership: modifierGroupModifiers, modifier: modifiers })
          .from(modifierGroupModifiers)
          .innerJoin(modifiers, eq(modifiers.id, modifierGroupModifiers.modifierId))
          .where(
            and(
              inArray(modifierGroupModifiers.modifierGroupId, groupIds),
              eq(modifierGroupModifiers.active, true),
              eq(modifiers.active, true),
            ),
          )
          .orderBy(asc(modifierGroupModifiers.displayOrder));

  const groupsOf = (menuItemId: string): OperationalModifierGroup[] =>
    attachments
      .filter(({ attachment }) => attachment.menuItemId === menuItemId)
      .map(({ attachment, group }) => {
        const constraints = effectiveConstraints(
          { ...group, selectionType: group.selectionType as SelectionType },
          attachment,
        );

        return {
          id: group.id,
          code: group.code,
          name: group.name,
          selectionType: group.selectionType as SelectionType,
          minimumSelections: constraints.minimum,
          maximumSelections: constraints.maximum,
          modifiers: members
            .filter(({ membership }) => membership.modifierGroupId === group.id)
            .map(({ modifier }) => ({
              id: modifier.id,
              code: modifier.code,
              name: modifier.name,
              priceAdjustment: modifier.priceAdjustment,
              preparationEffectType: modifier.preparationEffectType,
              preparationInstruction: modifier.preparationInstruction,
            })),
        };
      });

  for (const menu of openMenus) {
    const categories = new Map<string, OperationalMenu["menus"][number]["categories"][number]>();

    for (const row of placed.filter((entry) => entry.menuId === menu.id)) {
      // An item with no price in effect can't be sold, so it isn't offered.
      const price = resolvePrice(
        priceRows.filter((entry) => entry.menuItemId === row.item.id),
        actor.locationId,
        at,
      );

      if (!price) {
        continue;
      }

      const category = categories.get(row.category.id) ?? {
        id: row.category.id,
        code: row.category.code,
        name: row.category.name,
        items: [],
      };

      category.items.push({
        placementId: row.placementId,
        menuItemId: row.item.id,
        code: row.item.code,
        name: row.item.name,
        shortName: row.item.shortName,
        description: row.item.description,
        itemType: row.item.itemType,
        price: price.price,
        priceScope: price.scope,
        prepStationIds: routing
          .filter((entry) => entry.menuItemId === row.item.id)
          .map((entry) => entry.stationId),
        modifierGroups: groupsOf(row.item.id),
      });
      categories.set(row.category.id, category);
    }

    result.menus.push({ ...menu, categories: [...categories.values()] });
  }

  return result;
}
