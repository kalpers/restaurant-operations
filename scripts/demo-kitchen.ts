import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import {
  DEMO_BURGER_GROUPS,
  DEMO_FOODS_COSTS,
  DEMO_INVENTORY_ITEMS,
  DEMO_MENU_ITEMS,
  DEMO_ORDER_NOTE,
  DEMO_PURCHASE_ORDERS,
  DEMO_SPIRITS_SUPPLIER,
  DEMO_SUPPLIER_ITEMS,
  DEMO_WASTE,
} from "../src/db/demo/demo-kitchen";
import { purchaseOrders } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import {
  addConversion,
  createItem as createInventoryItem,
  listItems as listInventoryItems,
  setItemLocation,
} from "../src/modules/inventory/services/item-service";
import {
  addPurchaseOrderLine,
  createPurchaseOrder,
  submitPurchaseOrder,
} from "../src/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "../src/modules/inventory/services/receiving-service";
import { recordWaste } from "../src/modules/inventory/services/stock-operations";
import {
  createSupplier,
  createSupplierItem,
  listSupplierItems,
  listSuppliers,
  updateSupplierItem,
} from "../src/modules/inventory/services/supplier-service";
import {
  createItem as createMenuItem,
  createPlacement,
  listCategories,
  listItems as listMenuItems,
  listMenus,
} from "../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../src/modules/menu/services/modifier-effect-service";
import {
  attachGroup,
  createGroup,
  createModifier,
  listGroups,
  listModifiers,
  setGroupModifier,
} from "../src/modules/menu/services/modifier-service";
import { listStations, setItemRouting } from "../src/modules/menu/services/prep-station-service";
import { changePrice } from "../src/modules/menu/services/pricing-service";
import { addIngredient } from "../src/modules/recipes/services/ingredient-service";
import {
  createDraftRevision,
  createRecipe,
  listRecipes,
  publishRevision,
} from "../src/modules/recipes/services/recipe-service";
import { listUnits } from "../src/modules/recipes/services/unit-service";
import { AppError } from "../src/shared/errors/app-error";

/** Ignores the "already there" refusals a rerun meets; anything else still fails. */
async function unlessExists(codes: readonly string[], work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof AppError && codes.includes(error.code))) {
      throw error;
    }
  }
}

function lookup<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Demo ${label} ${key} is missing. Run \`npm run db:seed\` first.`);
  }

  return value;
}

/**
 * Builds the demo menu, recipes and inventory through the real services. Each part checks
 * what already exists by code, so running it again adds nothing.
 */
export async function seedDemoKitchen(database: Database, actor: Actor) {
  const summary = { inventoryItems: 0, supplierItems: 0, menuItems: 0, recipes: 0, modifiers: 0, orders: 0 };
  const units = new Map((await listUnits(database, actor)).map((unit) => [unit.code, unit.id]));
  const unit = (code: string) => lookup(units, code, "unit");

  // ------------------------------------------------------------ inventory items
  const existingItems = new Set((await listInventoryItems(database, actor)).map((item) => item.code));

  for (const demo of DEMO_INVENTORY_ITEMS) {
    if (existingItems.has(demo.code)) {
      continue;
    }

    const item = await createInventoryItem(database, actor, {
      code: demo.code,
      name: demo.name,
      description: null,
      measurementType: demo.measurementType,
      baseUnitId: unit(demo.baseUnit),
    });

    for (const conversion of demo.conversions) {
      await addConversion(database, actor, item.id, {
        fromUnitId: unit(conversion.from),
        toUnitId: unit(conversion.to),
        factor: conversion.factor,
      });
    }

    await setItemLocation(database, actor, item.id, {
      parLevel: demo.levels.par,
      reorderLevel: demo.levels.reorder,
      reorderTarget: demo.levels.target,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });
    summary.inventoryItems += 1;
  }

  const items = new Map((await listInventoryItems(database, actor)).map((item) => [item.code, item]));
  const item = (code: string) => lookup(items, code, "inventory item");

  // ---------------------------------------------------- suppliers and supplier items
  if (!(await listSuppliers(database, actor)).some((supplier) => supplier.code === DEMO_SPIRITS_SUPPLIER.code)) {
    await createSupplier(database, actor, { ...DEMO_SPIRITS_SUPPLIER, contactName: "Sam Ortiz", phone: "555-0199", email: null });
  }

  const suppliers = new Map((await listSuppliers(database, actor)).map((supplier) => [supplier.code, supplier]));
  const supplierItemKey = (supplierId: string, inventoryItemId: string) => `${supplierId}:${inventoryItemId}`;
  const existingSupplierItems = new Set(
    (await listSupplierItems(database, actor)).map((row) => supplierItemKey(row.supplierId, row.inventoryItemId)),
  );

  for (const demo of DEMO_SUPPLIER_ITEMS) {
    const supplier = lookup(suppliers, demo.supplier, "supplier");

    if (existingSupplierItems.has(supplierItemKey(supplier.id, item(demo.item).id))) {
      continue;
    }

    await createSupplierItem(database, actor, supplier.id, {
      inventoryItemId: item(demo.item).id,
      purchaseUnitId: unit(demo.unit),
      supplierSku: demo.sku,
      lastUnitCost: demo.cost,
    });
    summary.supplierItems += 1;
  }

  // The baseline DEMO_FOODS items have no listed cost; give the ones the demo orders use one.
  for (const row of await listSupplierItems(database, actor)) {
    const supplierCode = [...suppliers.values()].find((supplier) => supplier.id === row.supplierId)?.code;
    const itemCode = [...items.values()].find((entry) => entry.id === row.inventoryItemId)?.code ?? "";
    const cost = DEMO_FOODS_COSTS[itemCode];

    if (supplierCode === "DEMO_FOODS" && cost && row.lastUnitCost === null) {
      await updateSupplierItem(database, actor, row.id, {
        supplierSku: row.supplierSku,
        lastUnitCost: cost,
        active: row.active,
        expectedVersion: row.version,
      });
    }
  }

  const supplierItems = await listSupplierItems(database, actor);
  const supplierItemFor = (supplierCode: string, itemCode: string) => {
    const supplier = lookup(suppliers, supplierCode, "supplier");
    const found = supplierItems.find(
      (row) => row.supplierId === supplier.id && row.inventoryItemId === item(itemCode).id,
    );

    if (!found) {
      throw new Error(`Demo supplier item ${supplierCode}/${itemCode} is missing.`);
    }

    return found;
  };

  // ------------------------------------------------- stock: orders, receipts, waste
  const [alreadyStocked] = await database
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.locationId, actor.locationId), eq(purchaseOrders.notes, DEMO_ORDER_NOTE)))
    .limit(1);

  if (!alreadyStocked) {
    for (const demo of DEMO_PURCHASE_ORDERS) {
      const supplier = lookup(suppliers, demo.supplier, "supplier");
      const order = await createPurchaseOrder(database, actor, {
        supplierId: supplier.id,
        expectedAt: null,
        notes: DEMO_ORDER_NOTE,
      });
      let version = order.version;
      const lineIds = new Map<string, string>();

      for (const line of demo.lines) {
        const added = await addPurchaseOrderLine(database, actor, order.id, {
          supplierItemId: supplierItemFor(demo.supplier, line.item).id,
          orderedQuantity: line.quantity,
          unitPrice: null,
          expectedVersion: version,
        });

        version += 1;
        lineIds.set(line.item, added.id);
      }

      if (demo.status !== "DRAFT") {
        await submitPurchaseOrder(database, actor, order.id, version);
        await receivePurchaseOrder(database, actor, order.id, {
          lines: demo.lines
            .filter((line) => String(line.receive) !== "0")
            .map((line) => ({
              purchaseOrderLineId: lineIds.get(line.item)!,
              receivedQuantity: line.receive,
              actualUnitCost: null,
            })),
          supplierReference: `DEMO-${String(summary.orders + 1).padStart(3, "0")}`,
          notes: null,
        });
      }

      summary.orders += 1;
    }

    for (const waste of DEMO_WASTE) {
      await recordWaste(database, actor, {
        inventoryItemId: item(waste.item).id,
        quantity: waste.quantity,
        unitOfMeasureId: unit(waste.unit),
        reasonCode: waste.reason,
        notes: waste.notes,
      });
    }
  }

  // ------------------------------------------------------------------- menu items
  const [mainMenu] = (await listMenus(database, actor)).filter((menu) => menu.code === "MAIN");

  if (!mainMenu) {
    throw new Error("The Main Menu is missing. Run `npm run db:seed` first.");
  }

  const categories = new Map((await listCategories(database, actor)).map((category) => [category.code, category.id]));
  const stations = new Map((await listStations(database, actor)).map((station) => [station.code, station.id]));
  const existingMenuItems = new Set((await listMenuItems(database, actor)).map((menuItem) => menuItem.code));

  for (const [index, demo] of DEMO_MENU_ITEMS.entries()) {
    if (existingMenuItems.has(demo.code)) {
      continue;
    }

    const menuItem = await createMenuItem(database, actor, {
      code: demo.code,
      name: demo.name,
      shortName: null,
      description: demo.description,
      itemType: demo.itemType,
      displayOrder: (index + 1) * 10,
    });

    await changePrice(database, actor, menuItem.id, { locationId: null, price: demo.price, effectiveFrom: null });
    await createPlacement(database, actor, {
      menuId: mainMenu.id,
      menuCategoryId: lookup(categories, demo.category, "category"),
      menuItemId: menuItem.id,
      displayOrder: (index + 1) * 10,
    });
    await setItemRouting(database, actor, menuItem.id, {
      prepStationIds: demo.stations.map((code) => lookup(stations, code, "prep station")),
    });
    summary.menuItems += 1;
  }

  const menuItems = new Map((await listMenuItems(database, actor)).map((menuItem) => [menuItem.code, menuItem.id]));

  // ---------------------------------------------------------------------- recipes
  const existingRecipes = new Set((await listRecipes(database, actor)).map((recipe) => recipe.code));

  for (const demo of DEMO_MENU_ITEMS) {
    if (existingRecipes.has(demo.code)) {
      continue;
    }

    const recipe = await createRecipe(database, actor, {
      code: demo.code,
      name: demo.name,
      description: null,
      menuItemId: lookup(menuItems, demo.code, "menu item"),
    });
    const draft = await createDraftRevision(database, actor, recipe.id, {
      yieldQuantity: demo.recipe.yieldQuantity,
      yieldUnitId: unit(demo.recipe.yieldUnit),
      preparationNotes: demo.recipe.notes,
    });
    let version = draft.version;

    for (const [index, ingredient] of demo.recipe.ingredients.entries()) {
      const added = await addIngredient(database, actor, recipe.id, draft.id, {
        inventoryItemId: item(ingredient.item).id,
        quantity: ingredient.quantity,
        unitOfMeasureId: unit(ingredient.unit),
        preparationNote: ingredient.note ?? null,
        sortOrder: index,
        expectedVersion: version,
      });

      version = added.revisionVersion;
    }

    await publishRevision(database, actor, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version });
    summary.recipes += 1;
  }

  // ------------------------------------------- burger modifier groups and effects
  const burgerId = lookup(menuItems, "BACON_CHEESEBURGER", "menu item");
  const groupCodes = new Map((await listGroups(database, actor)).map((group) => [group.code, group.id]));
  const modifierCodes = new Map((await listModifiers(database, actor)).map((modifier) => [modifier.code, modifier.id]));

  for (const [groupIndex, demo] of DEMO_BURGER_GROUPS.entries()) {
    let groupId = groupCodes.get(demo.code);

    if (!groupId) {
      groupId = (
        await createGroup(database, actor, {
          code: demo.code,
          name: demo.name,
          description: null,
          selectionType: demo.selectionType,
          minimumSelections: demo.minimumSelections,
          maximumSelections: demo.maximumSelections,
          displayOrder: groupIndex,
        })
      ).id;
    }

    for (const [index, modifier] of demo.modifiers.entries()) {
      let modifierId = modifierCodes.get(modifier.code);

      if (!modifierId) {
        modifierId = (
          await createModifier(database, actor, {
            code: modifier.code,
            name: modifier.name,
            description: null,
            priceAdjustment: modifier.priceAdjustment,
            preparationEffectType: modifier.instruction ? "INSTRUCTION" : (modifier.effectType ?? "NONE"),
            preparationInstruction: modifier.instruction ?? null,
          })
        ).id;
        modifierCodes.set(modifier.code, modifierId);
        summary.modifiers += 1;
      }

      await setGroupModifier(database, actor, groupId, { modifierId, displayOrder: index, active: true });
    }

    await unlessExists(["GROUP_ALREADY_ATTACHED"], () =>
      attachGroup(database, actor, burgerId, {
        modifierGroupId: groupId,
        displayOrder: groupIndex,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: null,
      }),
    );

    for (const modifier of demo.modifiers) {
      const modifierId = lookup(modifierCodes, modifier.code, "modifier");

      for (const effect of modifier.effects ?? []) {
        await unlessExists(["EFFECT_EXISTS"], () =>
          addModifierEffect(database, actor, modifierId, {
            menuItemId: burgerId,
            inventoryItemId: item(effect.item).id,
            effectType: effect.type,
            quantity: effect.quantity ?? null,
            unitOfMeasureId: effect.unit ? unit(effect.unit) : null,
          }),
        );
      }
    }
  }

  return summary;
}
