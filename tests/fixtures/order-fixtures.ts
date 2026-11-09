import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import {
  inventoryBalances,
  inventoryTransactions,
  orderItems,
  orders,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { setItemRouting, createStation } from "@/modules/menu/services/prep-station-service";
import { addModifierEffect } from "@/modules/menu/services/modifier-effect-service";
import { addIngredient } from "@/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, publishRevision } from "@/modules/recipes/services/recipe-service";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { unitId } from "./inventory-fixtures";
import { post, stockedItem } from "./inventory-fixtures";
import { actorWith } from "./employee-fixtures";
import {
  attachGroupWith,
  LONG_AGO,
  modifierFixture,
  sellableItem,
  uniqueCode,
} from "./menu-fixtures";
import { createRestaurantScenario, tableFixture, type RestaurantScenario } from "./restaurant-fixtures";

export const SERVER_ORDER_PERMISSIONS: readonly PermissionCode[] = [
  "restaurant.view",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.submit",
];

export const MANAGER_ORDER_PERMISSIONS: readonly PermissionCode[] = [
  ...SERVER_ORDER_PERMISSIONS,
  "orders.void",
  "orders.discount.apply",
  "orders.discount.manage",
];

/** A restaurant at location A with a server, a manager and a view-only user for orders. */
export async function createOrderScenario(database: Database) {
  const scenario = await createRestaurantScenario(database);

  return {
    ...scenario,
    serverActor: await actorWith(database, scenario, SERVER_ORDER_PERMISSIONS),
    manager: await actorWith(database, scenario, MANAGER_ORDER_PERMISSIONS),
    viewOnly: await actorWith(database, scenario, ["orders.view"]),
    units: {
      each: await unitId(database, "EACH"),
      ozWeight: await unitId(database, "OZ_WEIGHT"),
      lb: await unitId(database, "LB"),
    },
  };
}

export type OrderScenario = Awaited<ReturnType<typeof createOrderScenario>>;

/** Seats a party at a new table in the dining room (or bar) and returns the session. */
export async function seatedSession(
  database: Database,
  scenario: RestaurantScenario,
  options: { areaId?: string; partySize?: number } = {},
) {
  const tableId = await tableFixture(database, scenario, { areaId: options.areaId ?? scenario.dining });
  const session = await seatParty(database, scenario.owner, {
    tableIds: [tableId],
    partySize: options.partySize ?? 2,
    serverEmployeeId: null,
  });

  return { ...session, tableId };
}

/** Stock on hand for a fixture item, received at a known cost. */
export async function receive(
  database: Database,
  actor: Actor,
  inventoryItemId: string,
  quantity: string,
  unitOfMeasureId: string,
  totalCost: string,
) {
  return post(database, actor, {
    inventoryItemId,
    type: "RECEIVE",
    quantity,
    unitOfMeasureId,
    incomingTotalCost: totalCost,
  });
}

/**
 * The canonical Bacon Cheeseburger (README section 31) at location A, sold for 15.99:
 * recipe beef 0.5 LB (8 OZ_WEIGHT), bun 1, American 1, onion 1, pickles 3, bacon 2. Modifiers:
 * Medium/Well Done (required single, instruction only); No Onion (REMOVE onion); Extra
 * Pickles (+0.50, ADJUST pickles +2); Swiss instead of American (+1.00, REMOVE American, ADD
 * Swiss 1). Each ingredient is stocked with 100 base units at 0.10 per unit.
 */
export async function baconCheeseburger(database: Database, scenario: OrderScenario) {
  const owner = scenario.owner;
  const each = scenario.units.each;
  const stock = async (name: string, baseUnitId = each, measurementType: "COUNT" | "WEIGHT" = "COUNT") => {
    const item = await stockedItem(database, owner, { baseUnitId, measurementType, name });

    await receive(database, owner, item.id, "100", baseUnitId, "10.00");

    return item;
  };
  const beef = await stock("Ground beef", scenario.units.ozWeight, "WEIGHT");
  const bun = await stock("Brioche bun");
  const american = await stock("American cheese");
  const swiss = await stock("Swiss cheese");
  const onion = await stock("Onion slice");
  const pickles = await stock("Pickle chip");
  const bacon = await stock("Bacon strip");
  const { item: menuItem, menu, category } = await sellableItem(database, owner, {
    price: "15.99",
    name: "Bacon Cheeseburger",
  });
  const grill = await createStation(database, owner, {
    code: uniqueCode("GRL"),
    name: "Grill",
    stationType: "KITCHEN",
    sortOrder: 0,
  });

  await setItemRouting(database, owner, menuItem.id, { prepStationIds: [grill.id] });

  const recipe = await createRecipe(database, owner, {
    code: uniqueCode("RCP"),
    name: "Bacon Cheeseburger",
    description: null,
    menuItemId: menuItem.id,
  });
  const draft = await createDraftRevision(database, owner, recipe.id, {
    yieldQuantity: "1",
    yieldUnitId: each,
    preparationNotes: null,
  });
  let version = draft.version;

  for (const [inventoryItemId, quantity, unit] of [
    [beef.id, "0.5", scenario.units.lb],
    [bun.id, "1", each],
    [american.id, "1", each],
    [onion.id, "1", each],
    [pickles.id, "3", each],
    [bacon.id, "2", each],
  ] as const) {
    const added = await addIngredient(database, owner, recipe.id, draft.id, {
      inventoryItemId,
      quantity,
      unitOfMeasureId: unit,
      preparationNote: null,
      sortOrder: 0,
      expectedVersion: version,
    });

    version = added.revisionVersion;
  }

  const revision = await publishRevision(
    database,
    owner,
    recipe.id,
    draft.id,
    { effectiveFrom: null, expectedVersion: version },
    LONG_AGO,
  );

  const medium = await modifierFixture(database, owner, {
    name: "Medium",
    preparationEffectType: "INSTRUCTION",
    preparationInstruction: "Cook medium",
  });
  const wellDone = await modifierFixture(database, owner, {
    name: "Well Done",
    preparationEffectType: "INSTRUCTION",
    preparationInstruction: "Cook well done",
  });
  const noOnion = await modifierFixture(database, owner, {
    name: "No Onion",
    preparationEffectType: "REMOVE_COMPONENT",
    preparationInstruction: "No onion",
  });
  const extraPickles = await modifierFixture(database, owner, {
    name: "Extra Pickles",
    priceAdjustment: "0.50",
    preparationEffectType: "ADJUST_COMPONENT",
    preparationInstruction: "Extra pickles",
  });
  const swissInstead = await modifierFixture(database, owner, {
    name: "Swiss instead of American",
    priceAdjustment: "1.00",
    preparationEffectType: "INSTRUCTION",
    preparationInstruction: "Swiss, not American",
  });
  const temperature = await attachGroupWith(database, owner, menuItem.id, "REQUIRED_SINGLE", [
    medium.id,
    wellDone.id,
  ]);
  const toppings = await attachGroupWith(database, owner, menuItem.id, "OPTIONAL_MULTIPLE", [
    noOnion.id,
    extraPickles.id,
    swissInstead.id,
  ]);

  const effect = (
    modifierId: string,
    inventoryItemId: string,
    effectType: "ADD" | "REMOVE" | "ADJUST",
    quantity: string | null,
  ) =>
    addModifierEffect(database, owner, modifierId, {
      menuItemId: menuItem.id,
      inventoryItemId,
      effectType,
      quantity,
      unitOfMeasureId: quantity === null ? null : each,
    });

  await effect(noOnion.id, onion.id, "REMOVE", null);
  await effect(extraPickles.id, pickles.id, "ADJUST", "2");
  await effect(swissInstead.id, american.id, "REMOVE", null);
  await effect(swissInstead.id, swiss.id, "ADD", "1");

  const pick = (groupId: string, modifierId: string) => ({ modifierGroupId: groupId, modifierId });

  return {
    menu,
    category,
    menuItem,
    recipe,
    revision,
    grill,
    stock: { beef, bun, american, swiss, onion, pickles, bacon },
    modifiers: { medium, wellDone, noOnion, extraPickles, swissInstead },
    groups: { temperature: temperature.group, toppings: toppings.group },
    /** Medium, No Onion, Extra Pickles, Swiss instead of American. */
    canonicalSelections: [
      pick(temperature.group.id, medium.id),
      pick(toppings.group.id, noOnion.id),
      pick(toppings.group.id, extraPickles.id),
      pick(toppings.group.id, swissInstead.id),
    ],
    mediumOnly: [pick(temperature.group.id, medium.id)],
  };
}

export type Burger = Awaited<ReturnType<typeof baconCheeseburger>>;

/** A simple sellable item with no recipe or modifiers, such as a canned soda. */
export async function plainItem(database: Database, actor: Actor, price = "3.00", name = "Soda") {
  return (await sellableItem(database, actor, { price, name })).item;
}

export const newKey = () => `key-${randomUUID()}`;

export function orderRow(database: Database, orderId: string) {
  return database.select().from(orders).where(eq(orders.id, orderId)).then((rows) => rows[0]!);
}

export function itemRows(database: Database, orderId: string) {
  return database
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
}

export function ledgerFor(database: Database, inventoryItemId: string) {
  return database
    .select()
    .from(inventoryTransactions)
    .where(eq(inventoryTransactions.inventoryItemId, inventoryItemId))
    .orderBy(asc(inventoryTransactions.sequence));
}

export async function onHand(database: Database, inventoryItemId: string): Promise<string> {
  const [row] = await database
    .select({ quantity: inventoryBalances.quantityOnHand })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.inventoryItemId, inventoryItemId));

  return row?.quantity ?? "0.0000";
}

export { clearOrderData } from "./order-cleanup";
