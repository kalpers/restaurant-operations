import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../src/db";
import { DEMO_BURGER_GROUPS, DEMO_MENU_ITEMS } from "../src/db/demo/demo-kitchen";
import { inventoryItems, menuItems, modifierGroups, modifiers, orders, settlements } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { quantitiesOnHand } from "../src/modules/inventory/queries/item-facts";
import { listItems as listInventoryItems } from "../src/modules/inventory/services/item-service";
import { recordAdjustment } from "../src/modules/inventory/services/stock-operations";
import { getForecastModifierEffects } from "../src/modules/menu/queries/forecast-menu";
import {
  createItem as createMenuItem,
  createPlacement,
  listCategories,
  listItems as listMenuItems,
  listMenus,
} from "../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../src/modules/menu/services/modifier-effect-service";
import { attachGroup, listGroups, listModifiers } from "../src/modules/menu/services/modifier-service";
import { listStations, setItemRouting } from "../src/modules/menu/services/prep-station-service";
import { changePrice } from "../src/modules/menu/services/pricing-service";
import { listTaxCategories } from "../src/modules/menu/services/tax-service";
import { addDraftItem } from "../src/modules/orders/services/draft-item-service";
import { createOrder } from "../src/modules/orders/services/order-service";
import { resolveCurrentRequirementsForMenuItems } from "../src/modules/recipes/queries/menu-item-requirements";
import { addIngredient } from "../src/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, listRecipes, publishRevision } from "../src/modules/recipes/services/recipe-service";
import { listUnits } from "../src/modules/recipes/services/unit-service";
import { openSettlement, recordTender } from "../src/modules/settlements/services/settlement-service";
import { addDecimals, compareDecimals, multiplyExact, subtractDecimals, toScale } from "../src/shared/decimal/decimal";
import { AppError } from "../src/shared/errors/app-error";
import { businessDateOf } from "../src/shared/time/business-date-service";
import { addDays, dayOfWeek, localToInstant } from "../src/shared/time/zoned-time";
import { completeSettlement } from "../src/workflows/close-order/complete-settlement";
import { sendOrderItems } from "../src/workflows/submit-order/submit-order";

import { installShiftedClock, restoreClock, setClock } from "./demo-forecast-history";

// Phase 25 (D11, amendment): six weeks of fake closed takeout checks at MAIN selling three demo
// items made for it, "Demo prep burger", "Demo prep fries" and "Demo prep wings": copies of the
// demo kitchen's Bacon Cheeseburger (with the burger modifiers and their effects), French Fries
// and Buffalo Wings. The demo kitchen's own items can't have history, because their prices and
// recipes start the day they were seeded. The copies are made with the clock moved back before
// the history, so their price, recipe and the Phase 24 demo tax rate are in effect for all of
// it. Every check goes through the real order, SEND and settlement services, so consumption
// snapshots, the ledger and balances agree. Stock for all of it is added first as one demo
// adjustment per ingredient (FOUND_STOCK), dated before the history, so no SEND runs short.
// Idempotent: a business date that already has a closed demo prep check is skipped. Local dev
// DB only (behind the existing seed guard).

const CUSTOMER = "Demo prep history";
/** The Phase 24 demo tax category, whose rate starts before its own history. */
const HISTORY_TAX = "DEMO_HISTORY";
const HISTORY_DAYS = 42;
const TIME_ZONE_FALLBACK = "America/Detroit";
/** Busier toward the weekend. Index is day of week (0 = Sunday). */
const DAY_FACTOR = [0.9, 0.6, 0.7, 0.8, 1.0, 1.3, 1.4] as const;
/** Demo copies: their code, the demo kitchen item they copy, name and price. */
const DEMO_COPIES = [
  { code: "DEMO_PREP_BURGER", from: "BACON_CHEESEBURGER", name: "Demo prep burger", price: "14.99" },
  { code: "DEMO_PREP_FRIES", from: "FRENCH_FRIES", name: "Demo prep fries", price: "4.50" },
  { code: "DEMO_PREP_WINGS", from: "BUFFALO_WINGS", name: "Demo prep wings", price: "12.00" },
] as const;
const MODIFIER_GROUP: Record<string, string> = {
  TEMP_MEDIUM: "BURGER_TEMP",
  TEMP_MEDIUM_RARE: "BURGER_TEMP",
  TEMP_WELL_DONE: "BURGER_TEMP",
  SWISS_FOR_AMERICAN: "BURGER_CHEESE",
  NO_ONION: "BURGER_ADDONS",
  EXTRA_PICKLES: "BURGER_ADDONS",
};

type Line = { code: string; quantity: number; modifierCodes: string[] };
type Pick = { modifierGroupId: string; modifierId: string };

/** A fixed plan per date, so reruns and other machines see the same history. */
function linesFor(date: string, dayIndex: number): Line[] {
  const factor = DAY_FACTOR[dayOfWeek(date)]!;
  const burgers = Math.max(1, Math.round(6 * factor));
  const pickles = Math.round(burgers / 3);
  const noOnion = dayIndex % 2 === 0 ? 1 : 0;
  const swiss = dayIndex % 3 === 0 ? 1 : 0;
  const plain = burgers - pickles - noOnion - swiss;
  const lines: Line[] = [];

  if (plain > 0) {
    lines.push({ code: "DEMO_PREP_BURGER", quantity: plain, modifierCodes: ["TEMP_MEDIUM"] });
  }

  if (pickles > 0) {
    lines.push({ code: "DEMO_PREP_BURGER", quantity: pickles, modifierCodes: ["TEMP_MEDIUM", "EXTRA_PICKLES"] });
  }

  if (noOnion > 0) {
    lines.push({ code: "DEMO_PREP_BURGER", quantity: noOnion, modifierCodes: ["TEMP_MEDIUM_RARE", "NO_ONION"] });
  }

  if (swiss > 0) {
    lines.push({ code: "DEMO_PREP_BURGER", quantity: swiss, modifierCodes: ["TEMP_WELL_DONE", "SWISS_FOR_AMERICAN"] });
  }

  lines.push({ code: "DEMO_PREP_FRIES", quantity: Math.max(1, Math.round(5 * factor)), modifierCodes: [] });
  lines.push({ code: "DEMO_PREP_WINGS", quantity: Math.max(1, Math.round(3 * factor)), modifierCodes: [] });

  return lines;
}

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

function need<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Demo ${label} ${key} is missing. Run the demo kitchen seed first.`);
  }

  return value;
}

/**
 * Makes the three demo copies (menu item, price, placement, routing, recipe, and for the burger
 * its modifier groups and effects) at the current, moved-back time. Parts already there are left.
 */
async function ensureDemoItems(database: Database, owner: Actor): Promise<void> {
  const units = new Map((await listUnits(database, owner)).map((unit) => [unit.code, unit.id]));
  const stock = new Map((await listInventoryItems(database, owner)).map((item) => [item.code, item.id]));
  const taxCategory = (await listTaxCategories(database, owner)).find((row) => row.code === HISTORY_TAX);
  const [mainMenu] = (await listMenus(database, owner)).filter((menu) => menu.code === "MAIN");

  if (!taxCategory) {
    throw new Error("The demo history tax category is missing. Run the demo forecast history first.");
  }

  if (!mainMenu) {
    throw new Error("The Main Menu is missing. Run `npm run db:seed` first.");
  }

  const categories = new Map((await listCategories(database, owner)).map((category) => [category.code, category.id]));
  const stations = new Map((await listStations(database, owner)).map((station) => [station.code, station.id]));
  const existing = new Set((await listMenuItems(database, owner)).map((item) => item.code));

  for (const [index, copy] of DEMO_COPIES.entries()) {
    const source = DEMO_MENU_ITEMS.find((item) => item.code === copy.from)!;

    if (existing.has(copy.code)) {
      continue;
    }

    const item = await createMenuItem(database, owner, {
      code: copy.code,
      name: copy.name,
      shortName: null,
      description: "Fake sales for the prep and purchasing forecast demo. Not a real dish.",
      itemType: source.itemType,
      displayOrder: 9980 + index,
      taxCategoryId: taxCategory.id,
    });

    await changePrice(database, owner, item.id, { locationId: null, price: copy.price, effectiveFrom: null });
    await createPlacement(database, owner, {
      menuId: mainMenu.id,
      menuCategoryId: need(categories, source.category, "category"),
      menuItemId: item.id,
      displayOrder: 9980 + index,
    });
    await setItemRouting(database, owner, item.id, {
      prepStationIds: source.stations.map((code) => need(stations, code, "prep station")),
    });
  }

  const items = new Map((await listMenuItems(database, owner)).map((item) => [item.code, item.id]));
  const recipes = new Set((await listRecipes(database, owner)).map((recipe) => recipe.code));

  for (const copy of DEMO_COPIES) {
    const source = DEMO_MENU_ITEMS.find((item) => item.code === copy.from)!;

    if (recipes.has(copy.code)) {
      continue;
    }

    const recipe = await createRecipe(database, owner, {
      code: copy.code,
      name: copy.name,
      description: null,
      menuItemId: need(items, copy.code, "menu item"),
    });
    const draft = await createDraftRevision(database, owner, recipe.id, {
      yieldQuantity: source.recipe.yieldQuantity,
      yieldUnitId: need(units, source.recipe.yieldUnit, "unit"),
      preparationNotes: source.recipe.notes,
    });
    let version = draft.version;

    for (const [index, ingredient] of source.recipe.ingredients.entries()) {
      version = (
        await addIngredient(database, owner, recipe.id, draft.id, {
          inventoryItemId: need(stock, ingredient.item, "inventory item"),
          quantity: ingredient.quantity,
          unitOfMeasureId: need(units, ingredient.unit, "unit"),
          preparationNote: ingredient.note ?? null,
          sortOrder: index,
          expectedVersion: version,
        })
      ).revisionVersion;
    }

    await publishRevision(database, owner, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version });
  }

  const burgerId = need(items, "DEMO_PREP_BURGER", "menu item");
  const groups = new Map((await listGroups(database, owner)).map((group) => [group.code, group.id]));
  const modifierIds = new Map((await listModifiers(database, owner)).map((modifier) => [modifier.code, modifier.id]));

  for (const [groupIndex, demo] of DEMO_BURGER_GROUPS.entries()) {
    await unlessExists(["GROUP_ALREADY_ATTACHED"], () =>
      attachGroup(database, owner, burgerId, {
        modifierGroupId: need(groups, demo.code, "modifier group"),
        displayOrder: groupIndex,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: null,
      }),
    );

    for (const modifier of demo.modifiers) {
      for (const effect of modifier.effects ?? []) {
        await unlessExists(["EFFECT_EXISTS"], () =>
          addModifierEffect(database, owner, need(modifierIds, modifier.code, "modifier"), {
            menuItemId: burgerId,
            inventoryItemId: need(stock, effect.item, "inventory item"),
            effectType: effect.type,
            quantity: effect.quantity ?? null,
            unitOfMeasureId: effect.unit ? need(units, effect.unit, "unit") : null,
          }),
        );
      }
    }
  }
}

async function sellAndClose(
  database: Database,
  owner: Actor,
  input: { lines: Line[]; items: Map<string, string>; picks: Map<string, Pick> },
): Promise<void> {
  const order = await createOrder(database, owner, { orderType: "TAKEOUT", customerName: CUSTOMER });
  let version = order.version;

  for (const line of input.lines) {
    version = (
      await addDraftItem(database, owner, order.id, {
        expectedVersion: version,
        menuItemId: input.items.get(line.code)!,
        quantity: line.quantity,
        selections: line.modifierCodes.map((code) => input.picks.get(code)!),
        specialInstructions: null,
      })
    ).orderVersion;
  }

  await sendOrderItems(database, owner, order.id, { expectedVersion: version, idempotencyKey: `demo-prep-${order.id}` });

  const [row] = await database.select({ totalDue: orders.totalDue }).from(orders).where(eq(orders.id, order.id));
  const { settlementId } = await openSettlement(database, owner, order.id);
  const [opened] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, settlementId));

  await recordTender(database, owner, settlementId, {
    idempotencyKey: `demo-prep-tender-${order.id}`,
    tenderType: "EXTERNAL_CARD",
    outcome: "RECORDED",
    amount: row!.totalDue,
    tipAmount: null,
    receivedAmount: null,
    externalReference: null,
    providerName: null,
    cardBrand: null,
    cardLastFour: null,
    authorizationReference: null,
    otherDescription: null,
    failureReason: null,
    expectedVersion: opened!.version,
  });

  const [tendered] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, settlementId));

  await completeSettlement(database, owner, settlementId, {
    expectedVersion: tendered!.version,
    idempotencyKey: `demo-prep-close-${order.id}`,
  });
}

/** Ingredients for the whole plan: the recipe plus every ADD or upward ADJUST of a chosen modifier. */
async function stockNeeded(
  database: Database,
  owner: Actor,
  plan: Line[],
  items: Map<string, string>,
  picks: Map<string, Pick>,
  at: Date,
): Promise<Map<string, string>> {
  const ids = [...items.values()];
  const requirements = await resolveCurrentRequirementsForMenuItems(database, owner.organizationId, ids, at);
  const effects = await getForecastModifierEffects(database, { organizationId: owner.organizationId, menuItemIds: ids });
  const totals = new Map<string, string>();
  const add = (inventoryItemId: string, quantity: string) =>
    totals.set(inventoryItemId, addDecimals(totals.get(inventoryItemId) ?? "0", quantity));

  for (const line of plan) {
    const menuItemId = items.get(line.code)!;

    for (const requirement of requirements.get(menuItemId) ?? []) {
      add(requirement.inventoryItemId, multiplyExact(requirement.baseQuantity, String(line.quantity)));
    }

    for (const code of line.modifierCodes) {
      const modifierId = picks.get(code)!.modifierId;

      for (const effect of effects) {
        if (
          effect.menuItemId === menuItemId &&
          effect.modifierId === modifierId &&
          effect.operation !== "REMOVE" &&
          compareDecimals(effect.baseQuantity, "0") > 0
        ) {
          add(effect.inventoryItemId, multiplyExact(effect.baseQuantity, String(line.quantity)));
        }
      }
    }
  }

  return totals;
}

export async function seedDemoPrepHistory(
  database: Database,
  owner: Actor,
  clock: { timeZone: string | null; businessDayCutoff: string },
): Promise<{ checks: number; datesAlreadyPresent: number; stockAdded: number }> {
  const timeZone = clock.timeZone ?? TIME_ZONE_FALLBACK;
  const today = businessDateOf(new Date(), { timeZone, businessDayCutoff: clock.businessDayCutoff });
  const first = addDays(today, -HISTORY_DAYS);
  // Only closed checks count as done, so a check a failed run left open or voided is redone.
  const doneDates = new Set(
    (
      await database
        .selectDistinct({ businessDate: orders.businessDate })
        .from(orders)
        .where(and(eq(orders.locationId, owner.locationId), eq(orders.customerName, CUSTOMER), eq(orders.status, "CLOSED")))
    ).map((row) => row.businessDate),
  );
  const todo: { date: string; lines: Line[] }[] = [];

  for (let day = 0; day < HISTORY_DAYS; day += 1) {
    const date = addDays(first, day);

    if (!doneDates.has(date)) {
      todo.push({ date, lines: linesFor(date, day) });
    }
  }

  if (todo.length === 0) {
    return { checks: 0, datesAlreadyPresent: doneDates.size, stockAdded: 0 };
  }

  let checks = 0;
  let stockAdded = 0;

  installShiftedClock();

  try {
    // The demo items and their stock come first, "before" the history.
    setClock(localToInstant(addDays(first, -1), "09:00", timeZone)!);
    await ensureDemoItems(database, owner);

    const itemRows = await database
      .select({ id: menuItems.id, code: menuItems.code })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.organizationId, owner.organizationId),
          inArray(
            menuItems.code,
            DEMO_COPIES.map((copy) => copy.code),
          ),
        ),
      );
    const items = new Map(itemRows.map((row) => [row.code, row.id]));
    const pickRows = await database
      .select({ code: modifiers.code, modifierId: modifiers.id, modifierGroupId: modifierGroups.id, groupCode: modifierGroups.code })
      .from(modifiers)
      .innerJoin(modifierGroups, eq(modifierGroups.organizationId, modifiers.organizationId))
      .where(
        and(
          eq(modifiers.organizationId, owner.organizationId),
          inArray(modifierGroups.code, ["BURGER_TEMP", "BURGER_CHEESE", "BURGER_ADDONS"]),
        ),
      );
    const picks = new Map(
      pickRows
        .filter((row) => MODIFIER_GROUP[row.code] === row.groupCode)
        .map((row) => [row.code, { modifierGroupId: row.modifierGroupId, modifierId: row.modifierId }]),
    );

    if (picks.size < Object.keys(MODIFIER_GROUP).length) {
      throw new Error("The demo burger modifiers are missing. Run the demo kitchen seed first.");
    }

    const firstSale = localToInstant(todo[0]!.date, "18:30", timeZone)!;
    const needed = await stockNeeded(database, owner, todo.flatMap((entry) => entry.lines), items, picks, firstSale);
    const onHand = await quantitiesOnHand(database, owner.organizationId, owner.locationId, [...needed.keys()]);
    const baseUnits = new Map(
      (
        await database
          .select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId })
          .from(inventoryItems)
          .where(inArray(inventoryItems.id, [...needed.keys()]))
      ).map((row) => [row.id, row.baseUnitId]),
    );

    for (const [inventoryItemId, quantity] of [...needed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const current = onHand.get(inventoryItemId);
      const shortfall = toScale(subtractDecimals(quantity, current?.stocked ? current.quantityOnHand : "0"), 4);

      if (compareDecimals(shortfall, "0") <= 0) {
        continue;
      }

      await recordAdjustment(database, owner, {
        inventoryItemId,
        direction: "INCREASE",
        reasonCode: "FOUND_STOCK",
        quantity: shortfall,
        unitOfMeasureId: baseUnits.get(inventoryItemId)!,
        notes: "Demo stock for the prep forecast history (fake).",
      });
      stockAdded += 1;
    }

    for (const entry of todo) {
      const instant = localToInstant(entry.date, "18:30", timeZone);

      if (!instant) {
        continue;
      }

      setClock(instant);
      await sellAndClose(database, owner, { lines: entry.lines, items, picks });
      checks += 1;
    }
  } finally {
    restoreClock();
  }

  return { checks, datesAlreadyPresent: doneDates.size, stockAdded };
}
