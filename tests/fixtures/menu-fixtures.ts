import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { unitsOfMeasure } from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  createCategory,
  createItem,
  createMenu,
  createPlacement,
  setMenuLocation,
} from "@/modules/menu/services/catalog-service";
import {
  createGroup,
  createModifier,
  setGroupModifier,
  attachGroup,
} from "@/modules/menu/services/modifier-service";
import { changePrice } from "@/modules/menu/services/pricing-service";
import type { SelectionType } from "@/modules/menu/rules/modifier-selection";
import type { MenuItemType, PreparationEffectType } from "@/modules/menu/types";

import { actorAt, createRoleFixture, createUserFixture } from "./auth-fixtures";
import { actorWith, createHrScenario } from "./employee-fixtures";

export const MENU_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  "menu.view",
  "menu.edit",
  "menu.pricing.view",
  "menu.pricing.edit",
  "menu.modifiers.manage",
  "prep-stations.manage",
  "recipes.view",
  "recipes.edit",
];

export const uniqueCode = (prefix = "C") =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

/** An organization with an owner, a menu administrator, a menu-only viewer and outsiders. */
export async function createMenuScenario(database: Database) {
  const scenario = await createHrScenario(database);
  const admin = await actorWith(database, scenario, MENU_ADMIN_PERMISSIONS);
  const viewer = await actorWith(database, scenario, []);
  // Holds a permission, but not menu.view, so every menu operation must refuse them.
  const outsiderRole = await createRoleFixture(database, scenario.organizationId, [
    "restaurant.view",
  ]);
  const outsiderUser = await createUserFixture(database, {
    assignments: [{ roleId: outsiderRole, locationId: scenario.locationA }],
  });
  const outsider = await actorAt(
    database,
    outsiderUser.id,
    scenario.locationA,
    "restaurant.view",
  );
  // Another organization's administrator, for cross-organization checks.
  const other = await createHrScenario(database);

  return { ...scenario, admin, viewer, outsider, other: other.owner, otherScenario: other };
}

export type MenuScenario = Awaited<ReturnType<typeof createMenuScenario>>;

export async function categoryFixture(database: Database, actor: Actor, code = uniqueCode("CAT")) {
  return createCategory(database, actor, {
    code,
    name: `Category ${code}`,
    description: null,
    displayOrder: 0,
  });
}

export async function menuFixture(
  database: Database,
  actor: Actor,
  options: { offerAtLocation?: boolean } = {},
) {
  const menu = await createMenu(database, actor, {
    code: uniqueCode("MENU"),
    name: "Fixture menu",
    description: null,
    displayOrder: 0,
  });

  if (options.offerAtLocation ?? true) {
    await setMenuLocation(database, actor, menu.id, {
      locationId: actor.locationId,
      active: true,
    });
  }

  return menu;
}

export async function itemFixture(
  database: Database,
  actor: Actor,
  overrides: Partial<{ code: string; name: string; itemType: MenuItemType }> = {},
) {
  const code = overrides.code ?? uniqueCode("ITEM");

  return createItem(database, actor, {
    code,
    name: overrides.name ?? `Item ${code}`,
    shortName: null,
    description: null,
    itemType: overrides.itemType ?? "FOOD",
    displayOrder: 0,
  });
}

/** An instant well in the past, so a price or revision can already be in effect. */
export const LONG_AGO = new Date("2024-01-01T00:00:00Z");

/** Gives an item an organization-default price that took effect at `from`. */
export async function priceFixture(
  database: Database,
  actor: Actor,
  menuItemId: string,
  price: string,
  options: { locationId?: string | null; from?: Date } = {},
) {
  const from = options.from ?? LONG_AGO;

  return changePrice(
    database,
    actor,
    menuItemId,
    { locationId: options.locationId ?? null, price, effectiveFrom: null },
    from,
  );
}

export async function groupFixture(
  database: Database,
  actor: Actor,
  selectionType: SelectionType = "OPTIONAL_MULTIPLE",
  bounds: { minimumSelections?: number; maximumSelections?: number | null } = {},
) {
  const defaults: Record<SelectionType, { min: number; max: number | null }> = {
    OPTIONAL_SINGLE: { min: 0, max: 1 },
    REQUIRED_SINGLE: { min: 1, max: 1 },
    OPTIONAL_MULTIPLE: { min: 0, max: 3 },
    REQUIRED_MULTIPLE: { min: 1, max: 3 },
  };
  const code = uniqueCode("GRP");

  return createGroup(database, actor, {
    code,
    name: `Group ${code}`,
    description: null,
    selectionType,
    minimumSelections: bounds.minimumSelections ?? defaults[selectionType].min,
    maximumSelections:
      bounds.maximumSelections === undefined ? defaults[selectionType].max : bounds.maximumSelections,
    displayOrder: 0,
  });
}

export async function modifierFixture(
  database: Database,
  actor: Actor,
  options: {
    priceAdjustment?: string;
    preparationEffectType?: PreparationEffectType;
    preparationInstruction?: string | null;
    name?: string;
  } = {},
) {
  const code = uniqueCode("MOD");

  return createModifier(database, actor, {
    code,
    name: options.name ?? `Modifier ${code}`,
    description: null,
    priceAdjustment: options.priceAdjustment ?? "0.00",
    preparationEffectType: options.preparationEffectType ?? "NONE",
    preparationInstruction: options.preparationInstruction ?? null,
  });
}

/** A group holding the given modifiers, attached to the item. */
export async function attachGroupWith(
  database: Database,
  actor: Actor,
  menuItemId: string,
  selectionType: SelectionType,
  modifierIds: readonly string[],
  bounds: { minimumSelections?: number; maximumSelections?: number | null } = {},
) {
  const group = await groupFixture(database, actor, selectionType, bounds);

  for (const [index, modifierId] of modifierIds.entries()) {
    await setGroupModifier(database, actor, group.id, {
      modifierId,
      displayOrder: index,
      active: true,
    });
  }

  const attachment = await attachGroup(database, actor, menuItemId, {
    modifierGroupId: group.id,
    displayOrder: 0,
    requiredOverride: null,
    minimumOverride: null,
    maximumOverride: null,
  });

  return { group, attachment };
}

/** An item that is placed on a menu, priced, and ready to be sold. */
export async function sellableItem(
  database: Database,
  actor: Actor,
  options: { price?: string; name?: string } = {},
) {
  const menu = await menuFixture(database, actor);
  const category = await categoryFixture(database, actor);
  const item = await itemFixture(database, actor, { name: options.name });

  await priceFixture(database, actor, item.id, options.price ?? "14.99");
  await createPlacement(database, actor, {
    menuId: menu.id,
    menuCategoryId: category.id,
    menuItemId: item.id,
    displayOrder: 0,
  });

  return { menu, category, item };
}

export async function unitId(database: Database, code: string): Promise<string> {
  const [unit] = await database
    .select({ id: unitsOfMeasure.id })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.code, code));

  if (!unit) {
    throw new Error(`The seeded unit ${code} is missing.`);
  }

  return unit.id;
}
