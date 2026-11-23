import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  BURGER_KITCHEN_ITEMS,
  CALL_POUR_SWAPS,
  PIZZA_DECLARED_ALLERGENS,
  PIZZA_DISHES,
  PIZZA_GROUPS_DATA,
  PIZZA_INGREDIENTS,
  PIZZA_NUTRITION,
  type PizzaEffect,
} from "../../src/db/demo/pizza/menu";
import { inventoryItemNutrition, inventoryItems, menuItems, modifierGroups, modifiers, suppliers } from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { addConversion, createItem as createInventoryItem, getItemConfiguration, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { createSupplierItem } from "../../src/modules/inventory/services/supplier-service";
import { createItem as createMenuItem, createPlacement, getItem, listCategories, listMenus, updateItem } from "../../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../../src/modules/menu/services/modifier-effect-service";
import { attachGroup, createGroup, createModifier, setGroupModifier } from "../../src/modules/menu/services/modifier-service";
import { listStations, setItemRouting } from "../../src/modules/menu/services/prep-station-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { createDiscountDefinition, listDiscountDefinitions } from "../../src/modules/orders/services/discount-service";
import { addIngredient } from "../../src/modules/recipes/services/ingredient-service";
import { setIngredientNutrition } from "../../src/modules/recipes/services/nutrition-service";
import { createDraftRevision, createRecipe, publishRevision } from "../../src/modules/recipes/services/recipe-service";
import { listUnits } from "../../src/modules/recipes/services/unit-service";
import { seedDeclaredAllergens, seedIngredientAllergens } from "../demo-guests-allergens";
import { seedDemoKitchen } from "../demo-kitchen";

import { setClock } from "./clock";
import { need, unlessExists } from "./helpers";

export type MenuSummary = { burgerKitchen: string; ingredients: number; menuItems: number; taxed: number; groups: number; effects: number; allergenTags: number; nutrition: number };

/**
 * The whole menu: the burger kitchen first (the canonical Bacon Cheeseburger and the validation
 * fixture's items), then the pizza ingredients, dishes and drinks with prices, recipes, routing,
 * the 6% sales tax on every item, modifier groups with their inventory effects, a manager comp,
 * allergen tags and a few nutrition facts. Run with the shifted clock installed and set to before
 * the history; the modifier effects are added two hours later, once the recipes are in effect.
 * Each part skips what exists, so reruns add nothing.
 */
export async function seedPizzaMenu(database: Database, owner: Actor, taxCategoryId: string, setupAt: Date): Promise<MenuSummary> {
  const summary: MenuSummary = { burgerKitchen: "", ingredients: 0, menuItems: 0, taxed: 0, groups: 0, effects: 0, allergenTags: 0, nutrition: 0 };
  const kitchen = await seedDemoKitchen(database, owner);

  summary.burgerKitchen = `${kitchen.menuItems} items, ${kitchen.inventoryItems} ingredients, ${kitchen.orders} purchase orders`;

  const units = new Map((await listUnits(database, owner)).map((unit) => [unit.code, unit.id]));
  const unit = (code: string) => need(units, code, "unit");
  const stock = new Map(
    (await database.select({ id: inventoryItems.id, code: inventoryItems.code }).from(inventoryItems).where(eq(inventoryItems.organizationId, owner.organizationId))).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const supplierIds = new Map(
    (await database.select({ id: suppliers.id, code: suppliers.code }).from(suppliers).where(eq(suppliers.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );

  // ------------------------------------------------------------- ingredients
  for (const ingredient of PIZZA_INGREDIENTS) {
    if (stock.has(ingredient.code)) {
      continue;
    }

    const item = await createInventoryItem(database, owner, {
      code: ingredient.code,
      name: ingredient.name,
      description: null,
      measurementType: ingredient.measurementType,
      baseUnitId: unit(ingredient.baseUnit),
    });

    for (const conversion of ingredient.conversions) {
      await addConversion(database, owner, item.id, { fromUnitId: unit(conversion.from), toUnitId: unit(conversion.to), factor: conversion.factor });
    }

    const supplierItem = await createSupplierItem(database, owner, need(supplierIds, ingredient.supplier, "supplier"), {
      inventoryItemId: item.id,
      purchaseUnitId: unit(ingredient.purchaseUnit),
      supplierSku: ingredient.code.slice(0, 12),
      lastUnitCost: ingredient.cost,
    });

    await setItemLocation(database, owner, item.id, {
      parLevel: ingredient.levels.par,
      reorderLevel: ingredient.levels.reorder,
      reorderTarget: ingredient.levels.par,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });

    const here = (await getItemConfiguration(database, owner, item.id)).locations.find((row) => row.locationId === owner.locationId)!;

    await setItemLocation(database, owner, item.id, {
      parLevel: ingredient.levels.par,
      reorderLevel: ingredient.levels.reorder,
      reorderTarget: ingredient.levels.par,
      storageNote: null,
      active: true,
      preferredSupplierItemId: supplierItem.id,
      expectedVersion: here.version,
    });
    stock.set(ingredient.code, item.id);
    summary.ingredients += 1;
  }

  // ------------------------------------------------------------- menu items
  const [mainMenu] = (await listMenus(database, owner)).filter((menu) => menu.code === "MAIN");
  const categories = new Map((await listCategories(database, owner)).map((category) => [category.code, category.id]));
  const stations = new Map((await listStations(database, owner)).map((station) => [station.code, station.id]));
  const existingMenu = new Set(
    (await database.select({ code: menuItems.code }).from(menuItems).where(eq(menuItems.organizationId, owner.organizationId))).map((row) => row.code),
  );

  for (const [index, dish] of PIZZA_DISHES.entries()) {
    if (existingMenu.has(dish.code)) {
      continue;
    }

    const item = await createMenuItem(database, owner, {
      code: dish.code,
      name: dish.name,
      shortName: null,
      description: dish.description,
      itemType: dish.itemType,
      displayOrder: 100 + index * 10,
      taxCategoryId,
    });

    await changePrice(database, owner, item.id, { locationId: null, price: dish.price, effectiveFrom: null });
    await createPlacement(database, owner, {
      menuId: mainMenu!.id,
      menuCategoryId: need(categories, dish.category, "category"),
      menuItemId: item.id,
      displayOrder: 100 + index * 10,
    });
    await setItemRouting(database, owner, item.id, { prepStationIds: [need(stations, dish.station, "prep station")] });

    const recipe = await createRecipe(database, owner, { code: dish.code, name: dish.name, description: null, menuItemId: item.id });
    const draft = await createDraftRevision(database, owner, recipe.id, { yieldQuantity: "1", yieldUnitId: unit("EACH"), preparationNotes: null });
    let version = draft.version;

    for (const [order, ingredient] of dish.ingredients.entries()) {
      version = (
        await addIngredient(database, owner, recipe.id, draft.id, {
          inventoryItemId: need(stock, ingredient.item, "inventory item"),
          quantity: ingredient.quantity,
          unitOfMeasureId: unit(ingredient.unit),
          preparationNote: null,
          sortOrder: order,
          expectedVersion: version,
        })
      ).revisionVersion;
    }

    await publishRevision(database, owner, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version });
    summary.menuItems += 1;
  }

  // Every item sold carries the one sales tax, including the burger kitchen's.
  const allItems = await database
    .select({ id: menuItems.id, taxCategoryId: menuItems.taxCategoryId })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, [...PIZZA_DISHES.map((dish) => dish.code), ...BURGER_KITCHEN_ITEMS])));

  for (const row of allItems.filter((entry) => entry.taxCategoryId !== taxCategoryId)) {
    const item = await getItem(database, owner, row.id);

    await updateItem(database, owner, row.id, {
      name: item.name,
      shortName: item.shortName,
      description: item.description,
      itemType: item.itemType as "FOOD",
      displayOrder: item.displayOrder,
      taxCategoryId,
      active: item.active,
      available: item.available,
      expectedVersion: item.version,
    });
    summary.taxed += 1;
  }

  // ------------------------------------------------- modifier groups, effects
  // Two hours later, so the recipes published above are in effect for REMOVE effects.
  setClock(new Date(setupAt.getTime() + 2 * 3_600_000));

  const menuIds = new Map(
    (await database.select({ id: menuItems.id, code: menuItems.code }).from(menuItems).where(eq(menuItems.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );
  const groupIds = new Map(
    (await database.select({ id: modifierGroups.id, code: modifierGroups.code }).from(modifierGroups).where(eq(modifierGroups.organizationId, owner.organizationId))).map(
      (row) => [row.code, row.id],
    ),
  );
  const modifierIds = new Map(
    (await database.select({ id: modifiers.id, code: modifiers.code }).from(modifiers).where(eq(modifiers.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );

  for (const [groupIndex, group] of PIZZA_GROUPS_DATA.entries()) {
    let groupId = groupIds.get(group.code);

    if (!groupId) {
      groupId = (
        await createGroup(database, owner, {
          code: group.code,
          name: group.name,
          description: null,
          selectionType: group.selectionType,
          minimumSelections: group.minimumSelections,
          maximumSelections: group.maximumSelections,
          displayOrder: 10 + groupIndex,
        })
      ).id;
      groupIds.set(group.code, groupId);
      summary.groups += 1;
    }

    for (const [index, modifier] of group.modifiers.entries()) {
      let modifierId = modifierIds.get(modifier.code);

      if (!modifierId) {
        const adds = [...(modifier.effects.always ?? []), ...(modifier.effects.perRecipe ?? [])];
        const kinds = new Set(adds.map((effect) => effect.type));

        modifierId = (
          await createModifier(database, owner, {
            code: modifier.code,
            name: modifier.name,
            description: null,
            priceAdjustment: modifier.price,
            preparationEffectType: kinds.size === 0 ? "INSTRUCTION" : kinds.size > 1 || modifier.code === "CALL_POUR" ? "ADJUST_COMPONENT" : kinds.has("ADD") ? "ADD_COMPONENT" : "REMOVE_COMPONENT",
            preparationInstruction: modifier.name,
          })
        ).id;
        modifierIds.set(modifier.code, modifierId);
      }

      await setGroupModifier(database, owner, groupId, { modifierId, displayOrder: index, active: true });
    }
  }

  for (const dish of PIZZA_DISHES) {
    const menuItemId = need(menuIds, dish.code, "menu item");
    const inRecipe = new Set(dish.ingredients.map((ingredient) => ingredient.item));

    for (const [order, code] of (dish.groups ?? []).entries()) {
      const group = PIZZA_GROUPS_DATA.find((entry) => entry.code === code)!;

      await unlessExists(["GROUP_ALREADY_ATTACHED"], () =>
        attachGroup(database, owner, menuItemId, {
          modifierGroupId: need(groupIds, code, "modifier group"),
          displayOrder: order,
          requiredOverride: null,
          minimumOverride: null,
          maximumOverride: null,
        }),
      );

      for (const modifier of group.modifiers) {
        const effects: PizzaEffect[] = [
          ...(modifier.effects.always ?? []),
          ...(modifier.effects.perRecipe ?? []).filter((effect) => inRecipe.has(effect.item)),
        ];

        if (modifier.code === "CALL_POUR") {
          for (const [well, call] of Object.entries(CALL_POUR_SWAPS)) {
            if (inRecipe.has(well)) {
              effects.push({ type: "ADD", ...call });
            }
          }
        }

        for (const effect of effects) {
          await unlessExists(["EFFECT_EXISTS"], async () => {
            await addModifierEffect(database, owner, need(modifierIds, modifier.code, "modifier"), {
              menuItemId,
              inventoryItemId: need(stock, effect.item, "inventory item"),
              effectType: effect.type,
              quantity: effect.type === "ADD" ? effect.quantity : null,
              unitOfMeasureId: effect.type === "ADD" ? unit(effect.unit) : null,
            });
            summary.effects += 1;
          });
        }
      }
    }
  }

  // A manager comp: 100% off one item.
  if (!(await listDiscountDefinitions(database, owner)).some((row) => row.code === "MANAGER_COMP")) {
    await createDiscountDefinition(database, owner, { code: "MANAGER_COMP", name: "Manager comp", scope: "ITEM", discountType: "PERCENTAGE", value: "100" });
  }

  // ------------------------------------------------- allergens and nutrition
  summary.allergenTags += await seedIngredientAllergens(database, owner);
  summary.allergenTags += await seedIngredientAllergens(
    database,
    owner,
    Object.fromEntries(PIZZA_INGREDIENTS.map((ingredient) => [ingredient.code, ingredient.allergens])),
  );
  await seedDeclaredAllergens(database, owner);
  await seedDeclaredAllergens(database, owner, PIZZA_DECLARED_ALLERGENS);

  const withFacts = new Set((await database.select({ id: inventoryItemNutrition.inventoryItemId }).from(inventoryItemNutrition)).map((row) => row.id));

  for (const [code, facts] of Object.entries(PIZZA_NUTRITION)) {
    const inventoryItemId = need(stock, code, "inventory item");

    if (withFacts.has(inventoryItemId)) {
      continue;
    }

    const { basis, ...values } = facts;

    await setIngredientNutrition(database, owner, { inventoryItemId, basisQuantity: basis, values, expectedVersion: null });
    summary.nutrition += 1;
  }

  return summary;
}
