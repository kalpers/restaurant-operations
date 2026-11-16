import { randomUUID } from "node:crypto";

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Database } from "../src/db";
import {
  employees,
  guestParties,
  guestProfiles,
  inventoryItems,
  kitchenTicketItems,
  locations,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  positions,
  reservations,
  restaurantAreas,
  restaurantTables,
  schedulePeriods,
  seedRuns,
  settlements,
  shiftAssignments,
  shifts,
  staffingTemplates,
  supplierItems,
  suppliers,
  tableSessionTables,
  tableSessions,
  timeEntries,
} from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { quantitiesOnHand } from "../src/modules/inventory/queries/item-facts";
import {
  addConversion,
  createItem as createInventoryItem,
  getItemConfiguration,
  setItemLocation,
} from "../src/modules/inventory/services/item-service";
import { addPurchaseOrderLine, createPurchaseOrder, submitPurchaseOrder } from "../src/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "../src/modules/inventory/services/receiving-service";
import { recordAdjustment } from "../src/modules/inventory/services/stock-operations";
import { createSupplierItem } from "../src/modules/inventory/services/supplier-service";
import { transitionTicketItem } from "../src/modules/kitchen/services/fulfillment-service";
import { getForecastModifierEffects } from "../src/modules/menu/queries/forecast-menu";
import { getOperationalMenu } from "../src/modules/menu/queries/operational-menu";
import { createItem as createMenuItem, createPlacement, listCategories, listMenus } from "../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../src/modules/menu/services/modifier-effect-service";
import { attachGroup, createGroup, createModifier, setGroupModifier } from "../src/modules/menu/services/modifier-service";
import { listStations, setItemRouting } from "../src/modules/menu/services/prep-station-service";
import { changePrice } from "../src/modules/menu/services/pricing-service";
import { changeTaxRate, createTaxCategory, listTaxCategories } from "../src/modules/menu/services/tax-service";
import { applyItemDiscount, createDiscountDefinition, listDiscountDefinitions } from "../src/modules/orders/services/discount-service";
import { addDraftItem } from "../src/modules/orders/services/draft-item-service";
import { createOrder } from "../src/modules/orders/services/order-service";
import { resolveCurrentRequirementsForMenuItems } from "../src/modules/recipes/queries/menu-item-requirements";
import { addIngredient } from "../src/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, publishRevision } from "../src/modules/recipes/services/recipe-service";
import { listUnits } from "../src/modules/recipes/services/unit-service";
import {
  createOnlineReservation,
  getOnlineBookingSettings,
  replaceBookingPeriods,
  saveOnlineBookingSettings,
} from "../src/modules/reservations/services/online-booking-service";
import { checkInReservation, createReservation } from "../src/modules/reservations/services/reservation-service";
import { addToWaitlist } from "../src/modules/reservations/services/waitlist-service";
import { cleanTable } from "../src/modules/restaurant/services/table-service";
import { addRequirement, applyTemplate, createTemplate } from "../src/modules/scheduling/services/config-service";
import { runGeneration } from "../src/modules/scheduling/services/generation-service";
import { createPeriod, publishPeriod } from "../src/modules/scheduling/services/schedule-service";
import { clockIn, clockOut } from "../src/modules/scheduling/services/timeclock-service";
import { openSettlement, recordTender } from "../src/modules/settlements/services/settlement-service";
import { addDecimals, compareDecimals, multiplyExact, roundHalfUp, subtractDecimals, toScale, wholeQuotientCeiling } from "../src/shared/decimal/decimal";
import { AppError } from "../src/shared/errors/app-error";
import { businessDateOf } from "../src/shared/time/business-date-service";
import { addDays, dayOfWeek, localToInstant } from "../src/shared/time/zoned-time";
import { completeSettlement } from "../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../src/workflows/end-table-session/end-table-session";
import { finalizeTipDistribution } from "../src/workflows/finalize-tip-distribution/finalize-tip-distribution";
import { seatReservationParty } from "../src/workflows/seat-guest-party/seat-guest-party";
import { seatParty } from "../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../src/workflows/submit-order/submit-order";
import { voidOrderItem } from "../src/workflows/void-order-item/void-order-item";

import { installShiftedClock, restoreClock, setClock } from "./demo-forecast-history";

// Demo service history (added after Phase 25, owner request 2026-11-16). Local dev DB only,
// behind the existing seed guard, all through the real services with this script's clock moved
// back, so ledgers, snapshots, tickets, settlements, schedules and tip pools all agree.
//
// 1. A larger menu: twelve dishes and drinks with their own ingredients, supplier items, recipes
//    and a salad modifier group, made "six weeks ago" with a tax category whose rate starts then.
//    (The original five items have prices from 2026-11-08 and Michigan Sales Tax from 2026-11-12,
//    so they join the history from 2026-11-12.)
// 2. Weekly schedules (a "Demo week" template, generated and published before each week).
// 3. Daily service at MAIN: dine-in with the server on shift, bar tabs and takeout; kitchen and
//    bar tickets worked to completed; a few voids and manager comps; card and cash with tips;
//    tables completed and cleaned. Some parties come from reservations linked to guest profiles.
//    Stock arrives each Sunday on purchase orders sized to the week.
// 4. Time clock punches for the past shifts (one overtime week, one missed clock-out yesterday),
//    and each past day's tip pool finalized (through two days ago).
// 5. Reservations for the next seven days (phone, and online with text consent), and tonight's
//    waitlist.
// Idempotent: every unit of work records a `seed_runs` key, and a rerun skips what is recorded.

const TIME_ZONE_FALLBACK = "America/Detroit";
const HISTORY_DAYS = 42;
/** The five original items: prices from 2026-11-08, their tax rate from 2026-11-12. */
const ORIGINAL_ITEMS_FROM = "2026-11-12";
const DAY_FACTOR = [1.1, 0.7, 0.75, 0.85, 1.0, 1.35, 1.45] as const;

type Unit = string;
type Ingredient = {
  code: string;
  name: string;
  measurementType: "COUNT" | "WEIGHT" | "VOLUME";
  baseUnit: Unit;
  conversions: { from: Unit; to: Unit; factor: string }[];
  supplier: "DEMO_FOODS" | "DEMO_SPIRITS";
  purchaseUnit: Unit;
  cost: string;
  levels: { par: string; reorder: string };
};

const INGREDIENTS: readonly Ingredient[] = [
  { code: "BREADED_ONION_RINGS", name: "Breaded onion rings", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "CASE", to: "LB", factor: "20" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "42.0000", levels: { par: "480", reorder: "160" } },
  { code: "MOZZARELLA_STICKS", name: "Mozzarella sticks (frozen)", measurementType: "COUNT", baseUnit: "EACH", conversions: [{ from: "CASE", to: "EACH", factor: "120" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "36.0000", levels: { par: "240", reorder: "60" } },
  { code: "MARINARA", name: "Marinara sauce", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "BOTTLE", to: "FL_OZ", factor: "64" }], supplier: "DEMO_FOODS", purchaseUnit: "BOTTLE", cost: "9.5000", levels: { par: "128", reorder: "32" } },
  { code: "ROMAINE", name: "Romaine hearts", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "CASE", to: "LB", factor: "20" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "31.0000", levels: { par: "320", reorder: "100" } },
  { code: "CAESAR_DRESSING", name: "Caesar dressing", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], supplier: "DEMO_FOODS", purchaseUnit: "BOTTLE", cost: "18.0000", levels: { par: "128", reorder: "40" } },
  { code: "CROUTONS", name: "Croutons", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "BAG", to: "LB", factor: "5" }], supplier: "DEMO_FOODS", purchaseUnit: "BAG", cost: "12.0000", levels: { par: "80", reorder: "20" } },
  { code: "PARMESAN", name: "Shaved parmesan", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "BAG", to: "LB", factor: "5" }], supplier: "DEMO_FOODS", purchaseUnit: "BAG", cost: "29.0000", levels: { par: "80", reorder: "20" } },
  { code: "CHICKEN_BREAST", name: "Chicken breast", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "CASE", to: "LB", factor: "40" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "120.0000", levels: { par: "640", reorder: "200" } },
  { code: "VEGGIE_PATTY", name: "Veggie patty", measurementType: "COUNT", baseUnit: "EACH", conversions: [{ from: "CASE", to: "EACH", factor: "48" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "54.0000", levels: { par: "48", reorder: "16" } },
  { code: "CIABATTA_ROLL", name: "Ciabatta roll", measurementType: "COUNT", baseUnit: "EACH", conversions: [{ from: "CASE", to: "EACH", factor: "48" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "22.0000", levels: { par: "48", reorder: "16" } },
  { code: "WHITE_FISH", name: "White fish fillet", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "CASE", to: "LB", factor: "10" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "85.0000", levels: { par: "160", reorder: "60" } },
  { code: "CORN_TORTILLA", name: "Corn tortilla", measurementType: "COUNT", baseUnit: "EACH", conversions: [{ from: "PACK", to: "EACH", factor: "60" }], supplier: "DEMO_FOODS", purchaseUnit: "PACK", cost: "6.0000", levels: { par: "120", reorder: "40" } },
  { code: "CABBAGE_SLAW", name: "Cabbage slaw", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "BAG", to: "LB", factor: "5" }], supplier: "DEMO_FOODS", purchaseUnit: "BAG", cost: "9.0000", levels: { par: "80", reorder: "24" } },
  { code: "ELBOW_PASTA", name: "Elbow pasta", measurementType: "WEIGHT", baseUnit: "OZ_WEIGHT", conversions: [{ from: "CASE", to: "LB", factor: "20" }], supplier: "DEMO_FOODS", purchaseUnit: "CASE", cost: "24.0000", levels: { par: "160", reorder: "48" } },
  { code: "CHEDDAR_SAUCE", name: "Cheddar sauce", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], supplier: "DEMO_FOODS", purchaseUnit: "BOTTLE", cost: "22.0000", levels: { par: "256", reorder: "64" } },
  { code: "TEQUILA_BLANCO", name: "Tequila blanco", measurementType: "VOLUME", baseUnit: "ML", conversions: [{ from: "CASE", to: "BOTTLE", factor: "12" }, { from: "BOTTLE", to: "L", factor: "1" }], supplier: "DEMO_SPIRITS", purchaseUnit: "CASE", cost: "260.0000", levels: { par: "6000", reorder: "2000" } },
  { code: "TRIPLE_SEC", name: "Triple sec", measurementType: "VOLUME", baseUnit: "ML", conversions: [{ from: "BOTTLE", to: "L", factor: "1" }], supplier: "DEMO_SPIRITS", purchaseUnit: "BOTTLE", cost: "14.0000", levels: { par: "2000", reorder: "600" } },
  { code: "BOURBON", name: "Bourbon", measurementType: "VOLUME", baseUnit: "ML", conversions: [{ from: "CASE", to: "BOTTLE", factor: "12" }, { from: "BOTTLE", to: "L", factor: "1" }], supplier: "DEMO_SPIRITS", purchaseUnit: "CASE", cost: "330.0000", levels: { par: "6000", reorder: "2000" } },
  { code: "ANGOSTURA_BITTERS", name: "Angostura bitters", measurementType: "VOLUME", baseUnit: "ML", conversions: [{ from: "BOTTLE", to: "ML", factor: "200" }], supplier: "DEMO_SPIRITS", purchaseUnit: "BOTTLE", cost: "11.0000", levels: { par: "200", reorder: "60" } },
  { code: "DRAFT_LAGER", name: "Draft lager (keg)", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "CASE", to: "FL_OZ", factor: "1984" }], supplier: "DEMO_SPIRITS", purchaseUnit: "CASE", cost: "135.0000", levels: { par: "1984", reorder: "500" } },
  { code: "SODA_SYRUP", name: "Fountain soda syrup", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "BOX", to: "FL_OZ", factor: "640" }], supplier: "DEMO_SPIRITS", purchaseUnit: "BOX", cost: "55.0000", levels: { par: "640", reorder: "160" } },
  { code: "ICED_TEA_BREW", name: "Iced tea (brewed)", measurementType: "VOLUME", baseUnit: "FL_OZ", conversions: [{ from: "BOX", to: "FL_OZ", factor: "384" }], supplier: "DEMO_SPIRITS", purchaseUnit: "BOX", cost: "12.0000", levels: { par: "384", reorder: "120" } },
];

type Dish = {
  code: string;
  name: string;
  description: string;
  category: string;
  itemType: "FOOD" | "BEVERAGE" | "ALCOHOL";
  price: string;
  station: string;
  ingredients: { item: string; quantity: string; unit: Unit }[];
};

const DISHES: readonly Dish[] = [
  { code: "ONION_RINGS", name: "Onion Rings", description: "Beer-battered, with ranch.", category: "APPETIZERS", itemType: "FOOD", price: "6.50", station: "FRY", ingredients: [{ item: "BREADED_ONION_RINGS", quantity: "6", unit: "OZ_WEIGHT" }] },
  { code: "MOZZARELLA_STICKS", name: "Mozzarella Sticks", description: "Six sticks with warm marinara.", category: "APPETIZERS", itemType: "FOOD", price: "8.00", station: "FRY", ingredients: [{ item: "MOZZARELLA_STICKS", quantity: "6", unit: "EACH" }, { item: "MARINARA", quantity: "2", unit: "FL_OZ" }] },
  { code: "CAESAR_SALAD", name: "Caesar Salad", description: "Romaine, parmesan, croutons, Caesar dressing.", category: "SALADS", itemType: "FOOD", price: "10.00", station: "SALAD", ingredients: [{ item: "ROMAINE", quantity: "5", unit: "OZ_WEIGHT" }, { item: "CAESAR_DRESSING", quantity: "2", unit: "FL_OZ" }, { item: "CROUTONS", quantity: "1", unit: "OZ_WEIGHT" }, { item: "PARMESAN", quantity: "0.5", unit: "OZ_WEIGHT" }] },
  { code: "VEGGIE_BURGER", name: "Veggie Burger", description: "House veggie patty, Swiss, onion, brioche.", category: "BURGERS", itemType: "FOOD", price: "13.00", station: "GRILL", ingredients: [{ item: "VEGGIE_PATTY", quantity: "1", unit: "EACH" }, { item: "BRIOCHE_BUN", quantity: "1", unit: "EACH" }, { item: "SWISS_CHEESE", quantity: "1", unit: "SLICE" }, { item: "YELLOW_ONION", quantity: "0.5", unit: "OZ_WEIGHT" }] },
  { code: "CHICKEN_SANDWICH", name: "Grilled Chicken Sandwich", description: "Grilled breast, romaine, ciabatta.", category: "ENTREES", itemType: "FOOD", price: "14.00", station: "GRILL", ingredients: [{ item: "CHICKEN_BREAST", quantity: "6", unit: "OZ_WEIGHT" }, { item: "CIABATTA_ROLL", quantity: "1", unit: "EACH" }, { item: "ROMAINE", quantity: "1", unit: "OZ_WEIGHT" }] },
  { code: "FISH_TACOS", name: "Fish Tacos", description: "Three tacos, grilled fish, slaw.", category: "ENTREES", itemType: "FOOD", price: "15.00", station: "GRILL", ingredients: [{ item: "WHITE_FISH", quantity: "6", unit: "OZ_WEIGHT" }, { item: "CORN_TORTILLA", quantity: "3", unit: "EACH" }, { item: "CABBAGE_SLAW", quantity: "2", unit: "OZ_WEIGHT" }] },
  { code: "MAC_AND_CHEESE", name: "Mac & Cheese", description: "Elbow pasta in cheddar sauce.", category: "ENTREES", itemType: "FOOD", price: "12.00", station: "GRILL", ingredients: [{ item: "ELBOW_PASTA", quantity: "4", unit: "OZ_WEIGHT" }, { item: "CHEDDAR_SAUCE", quantity: "4", unit: "FL_OZ" }] },
  { code: "MARGARITA", name: "Margarita", description: "Tequila, triple sec, fresh lime.", category: "COCKTAILS", itemType: "ALCOHOL", price: "10.00", station: "BAR", ingredients: [{ item: "TEQUILA_BLANCO", quantity: "45", unit: "ML" }, { item: "TRIPLE_SEC", quantity: "30", unit: "ML" }, { item: "LIME_JUICE", quantity: "0.75", unit: "FL_OZ" }] },
  { code: "OLD_FASHIONED", name: "Old Fashioned", description: "Bourbon, sugar, bitters.", category: "COCKTAILS", itemType: "ALCOHOL", price: "12.00", station: "BAR", ingredients: [{ item: "BOURBON", quantity: "60", unit: "ML" }, { item: "SIMPLE_SYRUP", quantity: "0.25", unit: "FL_OZ" }, { item: "ANGOSTURA_BITTERS", quantity: "2", unit: "ML" }] },
  { code: "DRAFT_LAGER", name: "Draft Lager", description: "16 oz pour.", category: "BEER", itemType: "ALCOHOL", price: "5.50", station: "BAR", ingredients: [{ item: "DRAFT_LAGER", quantity: "16", unit: "FL_OZ" }] },
  { code: "FOUNTAIN_SODA", name: "Fountain Soda", description: "Free refills.", category: "NON_ALCOHOLIC", itemType: "BEVERAGE", price: "2.50", station: "BAR", ingredients: [{ item: "SODA_SYRUP", quantity: "2", unit: "FL_OZ" }] },
  { code: "ICED_TEA", name: "Iced Tea", description: "Fresh brewed, unsweetened.", category: "NON_ALCOHOLIC", itemType: "BEVERAGE", price: "2.50", station: "BAR", ingredients: [{ item: "ICED_TEA_BREW", quantity: "12", unit: "FL_OZ" }] },
];

/** Salad choices: an ADD of chicken and a REMOVE of croutons. */
const SALAD_GROUP = {
  code: "SALAD_ADDS",
  name: "Salad add-ons",
  modifiers: [
    { code: "ADD_GRILLED_CHICKEN", name: "Add grilled chicken", price: "5.00", effect: { type: "ADD" as const, item: "CHICKEN_BREAST", quantity: "4", unit: "OZ_WEIGHT" } },
    { code: "NO_CROUTONS", name: "No croutons", price: "0.00", effect: { type: "REMOVE" as const, item: "CROUTONS" } },
  ],
};

const MAINS = ["VEGGIE_BURGER", "CHICKEN_SANDWICH", "FISH_TACOS", "MAC_AND_CHEESE", "CAESAR_SALAD"] as const;
const STARTERS = ["ONION_RINGS", "MOZZARELLA_STICKS"] as const;
const DRINKS = ["MARGARITA", "OLD_FASHIONED", "DRAFT_LAGER", "FOUNTAIN_SODA", "ICED_TEA"] as const;
const BAR_DRINKS = ["MARGARITA", "OLD_FASHIONED", "DRAFT_LAGER"] as const;

type Line = { code: string; quantity: number; modifierCodes: string[] };
type Kind = "DINE_IN" | "BAR" | "TAKEOUT";
type Check = {
  key: string;
  time: string;
  kind: Kind;
  partySize: number;
  lines: Line[];
  tender: "CARD" | "CASH";
  tipPercent: number;
  voidOne: boolean;
  compOne: boolean;
  /** Index into the demo guest profiles, for a reservation visit. */
  profile: number | null;
};

// ---------------------------------------------------------------------------- helpers

function seededRandom(seed: string): () => number {
  let state = 2166136261;

  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }

  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);

    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

const pickFrom = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
const between = (random: () => number, low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function need<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Demo ${label} ${key} is missing. Run the demo kitchen seed first.`);
  }

  return value;
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

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;

    return null;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    throw error;
  }
}

/** One day's checks, the same on every run. Original items join from 2026-11-12. */
function planFor(date: string, profileCount: number): Check[] {
  const random = seededRandom(`demo-service-${date}`);
  const factor = DAY_FACTOR[dayOfWeek(date)]!;
  const originals = date >= ORIGINAL_ITEMS_FROM;
  const mains: string[] = [...MAINS, ...(originals ? ["BACON_CHEESEBURGER", "BACON_CHEESEBURGER"] : [])];
  const starters: string[] = [...STARTERS, ...(originals ? ["FRENCH_FRIES", "BUFFALO_WINGS"] : [])];
  const drinks: string[] = [...DRINKS, ...(originals ? ["TITOS_GIMLET", "HOUSE_IPA"] : [])];
  const barDrinks: string[] = [...BAR_DRINKS, ...(originals ? ["TITOS_GIMLET", "HOUSE_IPA"] : [])];
  const checks: Check[] = [];
  const mainLine = (code: string): Line => {
    if (code === "BACON_CHEESEBURGER") {
      const temp = pickFrom(random, ["TEMP_MEDIUM", "TEMP_MEDIUM", "TEMP_MEDIUM_RARE", "TEMP_WELL_DONE"]);
      const extra = random() < 0.25 ? ["EXTRA_PICKLES"] : random() < 0.15 ? ["NO_ONION"] : [];

      return { code, quantity: 1, modifierCodes: [temp, ...extra] };
    }

    if (code === "CAESAR_SALAD") {
      return { code, quantity: 1, modifierCodes: random() < 0.45 ? ["ADD_GRILLED_CHICKEN"] : random() < 0.1 ? ["NO_CROUTONS"] : [] };
    }

    return { code, quantity: 1, modifierCodes: [] };
  };
  const tender = (): Pick<Check, "tender" | "tipPercent"> => ({
    tender: random() < 0.25 ? "CASH" : "CARD",
    tipPercent: pickFrom(random, [15, 18, 18, 20, 20, 22]),
  });
  const add = (time: number, kind: Kind, partySize: number, lines: Line[], profile: number | null = null) => {
    const merged = new Map<string, Line>();

    for (const line of lines) {
      const key = `${line.code}|${line.modifierCodes.join(",")}`;
      const current = merged.get(key);

      merged.set(key, current ? { ...current, quantity: current.quantity + line.quantity } : line);
    }

    const finalLines = [...merged.values()];
    const itemCount = finalLines.reduce((sum, line) => sum + line.quantity, 0);

    checks.push({
      key: `${date}#${checks.length}`,
      time: timeOf(time),
      kind,
      partySize,
      lines: finalLines,
      ...tender(),
      voidOne: itemCount >= 3 && random() < 0.05,
      compOne: itemCount >= 3 && random() < 0.05,
      profile,
    });
  };
  const table = (size: number) => {
    const lines: Line[] = [];

    for (let guest = 0; guest < size; guest += 1) {
      lines.push(mainLine(pickFrom(random, mains)));

      if (random() < 0.6) {
        lines.push({ code: pickFrom(random, drinks), quantity: 1, modifierCodes: [] });
      }
    }

    if (random() < 0.45) {
      lines.push({ code: pickFrom(random, starters), quantity: 1, modifierCodes: [] });
    }

    return lines;
  };

  const lunch = Math.round(3 * factor);
  const dinner = Math.round(6 * factor);

  for (let index = 0; index < lunch; index += 1) {
    const size = between(random, 1, 4);

    add(11 * 60 + 30 + index * 35 + between(random, 0, 15), "DINE_IN", size, table(size));
  }

  for (let index = 0; index < dinner; index += 1) {
    const size = between(random, 2, 4);
    const profile = profileCount > 0 && random() < 0.18 ? between(random, 0, profileCount - 1) : null;

    add(17 * 60 + index * 30 + between(random, 0, 15), "DINE_IN", size, table(size), profile);
  }

  for (let index = 0; index < Math.round(3 * factor); index += 1) {
    const size = between(random, 1, 2);
    const lines: Line[] = [];

    for (let guest = 0; guest < size; guest += 1) {
      for (let round = 0; round < between(random, 1, 2); round += 1) {
        lines.push({ code: pickFrom(random, barDrinks), quantity: 1, modifierCodes: [] });
      }
    }

    if (random() < 0.35) {
      lines.push({ code: pickFrom(random, starters), quantity: 1, modifierCodes: [] });
    }

    add(17 * 60 + 15 + index * 50 + between(random, 0, 20), "BAR", size, lines);
  }

  for (let index = 0; index < Math.round(2 * factor); index += 1) {
    const count = between(random, 1, 3);
    const lines = Array.from({ length: count }, () => mainLine(pickFrom(random, mains)));

    if (random() < 0.5) {
      lines.push({ code: pickFrom(random, starters), quantity: 1, modifierCodes: [] });
    }

    add(12 * 60 + index * 220 + between(random, 0, 30), "TAKEOUT", 1, lines);
  }

  return checks.sort((a, b) => a.time.localeCompare(b.time));
}

// ------------------------------------------------------------------------ the seed

export type ServiceHistorySummary = {
  menuItems: number;
  periods: number;
  checks: number;
  purchaseOrders: number;
  punches: number;
  tipDays: number;
  upcomingReservations: number;
  waitlist: number;
};

export async function seedDemoServiceHistory(
  database: Database,
  owner: Actor,
  clock: { timeZone: string | null; businessDayCutoff: string },
): Promise<ServiceHistorySummary> {
  const timeZone = clock.timeZone ?? TIME_ZONE_FALLBACK;
  const settings = { timeZone, businessDayCutoff: clock.businessDayCutoff };
  const today = businessDateOf(new Date(), settings);
  let first = addDays(today, -HISTORY_DAYS);

  while (dayOfWeek(first) !== 0) {
    first = addDays(first, -1);
  }

  const yesterday = addDays(today, -1);
  const at = (date: string, time: string) => localToInstant(date, time, timeZone)!;
  const done = new Set((await database.select({ key: seedRuns.seedKey }).from(seedRuns)).map((row) => row.key));
  const record = async (key: string) => {
    await database.insert(seedRuns).values({ seedKey: key }).onConflictDoNothing();
    done.add(key);
  };
  const summary: ServiceHistorySummary = {
    menuItems: 0,
    periods: 0,
    checks: 0,
    purchaseOrders: 0,
    punches: 0,
    tipDays: 0,
    upcomingReservations: 0,
    waitlist: 0,
  };
  const [location] = await database.select({ code: locations.locationCode }).from(locations).where(eq(locations.id, owner.locationId));

  installShiftedClock();

  try {
    // ------------------------------------------------------------- 1. menu
    if (!done.has("demo.service.menu")) {
      setClock(at(addDays(first, -2), "10:00"));
      summary.menuItems = await seedMenu(database, owner);
      await record("demo.service.menu");
    }

    // --------------------------------------------------------- 2. schedules
    const weeks: string[] = [];

    for (let week = first; week <= addDays(today, 7); week = addDays(week, 7)) {
      weeks.push(week);
    }

    const templateId = await ensureTemplate(database, owner);

    for (const week of weeks) {
      const key = `demo.service.period.${week}`;

      if (done.has(key)) {
        continue;
      }

      const end = addDays(week, 6);
      const [overlap] = await database
        .select({ id: schedulePeriods.id })
        .from(schedulePeriods)
        .where(
          and(
            eq(schedulePeriods.locationId, owner.locationId),
            lte(schedulePeriods.startDate, end),
            gte(schedulePeriods.endDate, week),
          ),
        );

      if (!overlap) {
        const future = week > today;

        if (future) {
          restoreClock();
        } else {
          setClock(at(addDays(week, -3), "10:00"));
        }

        const period = await createPeriod(database, owner, { name: `Week of ${week}`, startDate: week, endDate: end });
        const applied = await applyTemplate(database, owner, period.id, { templateId, expectedPeriodVersion: period.version });

        await runGeneration(database, owner, period.id, { mode: "GENERATE_DRAFT", expectedVersion: applied.periodVersion });

        if (!future) {
          const [row] = await database.select({ version: schedulePeriods.version }).from(schedulePeriods).where(eq(schedulePeriods.id, period.id));

          await publishPeriod(database, owner, period.id, { expectedVersion: row!.version });
        }

        if (future) {
          installShiftedClock();
        }

        summary.periods += 1;
      }

      await record(key);
    }

    // ------------------------------------------- 3. service, with weekly stock
    const context = await serviceContext(database, owner);

    for (let week = first; week <= yesterday; week = addDays(week, 7)) {
      const dates: string[] = [];

      for (let date = week; date <= addDays(week, 6) && date <= yesterday; date = addDays(date, 1)) {
        dates.push(date);
      }

      const plans = dates.map((date) => ({ date, checks: planFor(date, context.profiles.length).filter((check) => !done.has(`demo.service.check.${check.key}`)) }));

      if (plans.every((plan) => plan.checks.length === 0)) {
        continue;
      }

      // Delivered the morning of the first day still to serve; sized with the recipes in effect
      // by the week's last day (the original items' recipes start part way through a week).
      const firstDay = plans.find((plan) => plan.checks.length > 0)!.date;
      const lastDay = plans.at(-1)!.date;

      setClock(at(firstDay, "08:30"));
      summary.purchaseOrders += await stockTheWeek(database, owner, context, plans.flatMap((plan) => plan.checks), at(firstDay, "09:00"), at(lastDay, "23:00"));

      for (const plan of plans) {
        for (const check of plan.checks) {
          try {
            await serveCheck(database, owner, context, plan.date, check, at);
          } catch (error) {
            console.error(`Demo service check ${check.key} (${check.kind} at ${check.time}) failed.`);
            throw error;
          }
          await record(`demo.service.check.${check.key}`);
          summary.checks += 1;
        }
      }
    }

    // ------------------------------------------------- 4. punches and tips
    summary.punches += await punchShifts(database, owner, { first, yesterday, today, at, done, record });

    for (let date = first; date <= addDays(today, -2); date = addDays(date, 1)) {
      const key = `demo.service.tips.${date}`;

      if (done.has(key)) {
        continue;
      }

      setClock(at(addDays(date, 1), "10:00"));

      const code = await codeOf(finalizeTipDistribution(database, owner, { businessDate: date, idempotencyKey: `demo-tips-${date}` }));

      if (code === null) {
        summary.tipDays += 1;
      }

      await record(key);
    }

    // ------------------------------------------------- 5. front of house
    restoreClock();
    summary.upcomingReservations += await upcomingReservations(database, owner, location!.code, { today, timeZone, done, record, profiles: context.profiles });
    summary.waitlist += await tonightsWaitlist(database, owner, { today, done, record });
  } finally {
    restoreClock();
  }

  return summary;
}

// ------------------------------------------------------------------- 1. menu

async function seedMenu(database: Database, owner: Actor): Promise<number> {
  const units = new Map((await listUnits(database, owner)).map((unit) => [unit.code, unit.id]));
  const unit = (code: string) => need(units, code, "unit");
  const existingStock = new Map(
    (await database.select({ id: inventoryItems.id, code: inventoryItems.code }).from(inventoryItems).where(eq(inventoryItems.organizationId, owner.organizationId))).map(
      (row) => [row.code, row.id],
    ),
  );
  const supplierIds = new Map(
    (await database.select({ id: suppliers.id, code: suppliers.code }).from(suppliers).where(eq(suppliers.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );

  for (const ingredient of INGREDIENTS) {
    if (existingStock.has(ingredient.code)) {
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

    const config = await getItemConfiguration(database, owner, item.id);
    const here = config.locations.find((row) => row.locationId === owner.locationId)!;

    await setItemLocation(database, owner, item.id, {
      parLevel: ingredient.levels.par,
      reorderLevel: ingredient.levels.reorder,
      reorderTarget: ingredient.levels.par,
      storageNote: null,
      active: true,
      preferredSupplierItemId: supplierItem.id,
      expectedVersion: here.version,
    });
    existingStock.set(ingredient.code, item.id);
  }

  // A tax category whose rate starts now (moved back), for the new dishes.
  let tax = (await listTaxCategories(database, owner)).find((row) => row.code === "DINING_TAX");

  if (!tax) {
    tax = await createTaxCategory(database, owner, { code: "DINING_TAX", name: "Restaurant sales tax (6%)", description: "Food and drink served at the restaurant." });
    await changeTaxRate(database, owner, { taxCategoryId: tax.id, ratePercent: "6", effectiveFrom: null, expectedCurrentRateId: null });
  }

  const [mainMenu] = (await listMenus(database, owner)).filter((menu) => menu.code === "MAIN");
  const categories = new Map((await listCategories(database, owner)).map((category) => [category.code, category.id]));
  const stations = new Map((await listStations(database, owner)).map((station) => [station.code, station.id]));
  const existingMenu = new Set(
    (await database.select({ code: menuItems.code }).from(menuItems).where(eq(menuItems.organizationId, owner.organizationId))).map((row) => row.code),
  );
  let added = 0;

  for (const [index, dish] of DISHES.entries()) {
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
      taxCategoryId: tax.id,
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
          inventoryItemId: need(existingStock, ingredient.item, "inventory item"),
          quantity: ingredient.quantity,
          unitOfMeasureId: unit(ingredient.unit),
          preparationNote: null,
          sortOrder: order,
          expectedVersion: version,
        })
      ).revisionVersion;
    }

    await publishRevision(database, owner, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version });
    added += 1;
  }

  // The salad's add-ons. Each step skips what a partial earlier run already made. Two hours
  // later, so the recipe published above (even by an earlier, interrupted run) is in effect.
  setClock(new Date(Date.now() + 2 * 3_600_000));

  // The salad's add-ons. Each step skips what a partial earlier run already made.
  const [salad] = await database.select({ id: menuItems.id }).from(menuItems).where(and(eq(menuItems.organizationId, owner.organizationId), eq(menuItems.code, "CAESAR_SALAD")));
  let [group] = await database
    .select({ id: modifierGroups.id })
    .from(modifierGroups)
    .where(and(eq(modifierGroups.organizationId, owner.organizationId), eq(modifierGroups.code, SALAD_GROUP.code)));

  if (!group) {
    group = await createGroup(database, owner, {
      code: SALAD_GROUP.code,
      name: SALAD_GROUP.name,
      description: null,
      selectionType: "OPTIONAL_MULTIPLE",
      minimumSelections: 0,
      maximumSelections: 2,
      displayOrder: 10,
    });
  }

  const modifierIds = new Map(
    (await database.select({ id: modifiers.id, code: modifiers.code }).from(modifiers).where(eq(modifiers.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );

  for (const [index, modifier] of SALAD_GROUP.modifiers.entries()) {
    let modifierId = modifierIds.get(modifier.code);

    if (!modifierId) {
      modifierId = (
        await createModifier(database, owner, {
          code: modifier.code,
          name: modifier.name,
          description: null,
          priceAdjustment: modifier.price,
          preparationEffectType: modifier.effect.type === "ADD" ? "ADD_COMPONENT" : "REMOVE_COMPONENT",
          preparationInstruction: modifier.name,
        })
      ).id;
      modifierIds.set(modifier.code, modifierId);
    }

    await setGroupModifier(database, owner, group.id, { modifierId, displayOrder: index, active: true });
  }

  await unlessExists(["GROUP_ALREADY_ATTACHED"], () =>
    attachGroup(database, owner, salad!.id, {
      modifierGroupId: group!.id,
      displayOrder: 0,
      requiredOverride: null,
      minimumOverride: null,
      maximumOverride: null,
    }),
  );

  for (const modifier of SALAD_GROUP.modifiers) {
    await unlessExists(["EFFECT_EXISTS"], () =>
      addModifierEffect(database, owner, need(modifierIds, modifier.code, "modifier"), {
        menuItemId: salad!.id,
        inventoryItemId: need(existingStock, modifier.effect.item, "inventory item"),
        effectType: modifier.effect.type,
        quantity: modifier.effect.type === "ADD" ? (modifier.effect as { quantity: string }).quantity : null,
        unitOfMeasureId: modifier.effect.type === "ADD" ? unit((modifier.effect as { unit: string }).unit) : null,
      }),
    );
  }

  // A manager comp: 100% off one item.
  if (!(await listDiscountDefinitions(database, owner)).some((row) => row.code === "MANAGER_COMP")) {
    await createDiscountDefinition(database, owner, { code: "MANAGER_COMP", name: "Manager comp", scope: "ITEM", discountType: "PERCENTAGE", value: "100" });
  }

  return added;
}

// -------------------------------------------------------------- 2. schedules

async function ensureTemplate(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: staffingTemplates.id })
    .from(staffingTemplates)
    .where(and(eq(staffingTemplates.locationId, owner.locationId), eq(staffingTemplates.name, "Demo week")));

  if (existing) {
    return existing.id;
  }

  const positionRows = await database.select({ id: positions.id, code: positions.code }).from(positions).where(eq(positions.organizationId, owner.organizationId));
  const position = new Map(positionRows.map((row) => [row.code, row.id]));
  const template = await createTemplate(database, owner, { name: "Demo week", description: "Lunch and dinner cover for the demo restaurant." });
  const requirements = [
    { position: "SERVER", start: "11:00", end: "15:00", count: 1 },
    { position: "SERVER", start: "16:30", end: "22:30", count: 2 },
    { position: "BARTENDER", start: "16:00", end: "23:30", count: 1 },
    { position: "HOST", start: "17:00", end: "21:30", count: 1 },
    { position: "COOK", start: "10:30", end: "15:30", count: 1 },
    { position: "COOK", start: "16:00", end: "22:30", count: 1 },
  ];

  for (let day = 0; day < 7; day += 1) {
    for (const requirement of requirements) {
      await addRequirement(database, owner, template.id, {
        dayOfWeek: day,
        positionId: need(position, requirement.position, "position"),
        restaurantAreaId: null,
        startTime: requirement.start,
        endTime: requirement.end,
        requiredEmployeeCount: requirement.count,
        priority: 0,
      });
    }
  }

  return template.id;
}

// --------------------------------------------------------------- 3. service

type ServiceContext = {
  items: Map<string, string>;
  picks: Map<string, { modifierGroupId: string; modifierId: string }>;
  tables: { id: string; areaType: string; capacity: number; minimumCapacity: number | null }[];
  profiles: { id: string; name: string }[];
  serverPositionId: string;
  compId: string;
};

async function serviceContext(database: Database, owner: Actor): Promise<ServiceContext> {
  const codes = [...DISHES.map((dish) => dish.code), "BACON_CHEESEBURGER", "FRENCH_FRIES", "BUFFALO_WINGS", "TITOS_GIMLET", "HOUSE_IPA"];
  const items = new Map(
    (await database.select({ id: menuItems.id, code: menuItems.code }).from(menuItems).where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, codes)))).map(
      (row) => [row.code, row.id],
    ),
  );
  const groupOf: Record<string, string> = {
    TEMP_MEDIUM: "BURGER_TEMP",
    TEMP_MEDIUM_RARE: "BURGER_TEMP",
    TEMP_WELL_DONE: "BURGER_TEMP",
    NO_ONION: "BURGER_ADDONS",
    EXTRA_PICKLES: "BURGER_ADDONS",
    ADD_GRILLED_CHICKEN: "SALAD_ADDS",
    NO_CROUTONS: "SALAD_ADDS",
  };
  const pickRows = await database
    .select({ code: modifiers.code, modifierId: modifiers.id, modifierGroupId: modifierGroups.id, groupCode: modifierGroups.code })
    .from(modifiers)
    .innerJoin(modifierGroups, eq(modifierGroups.organizationId, modifiers.organizationId))
    .where(and(eq(modifiers.organizationId, owner.organizationId), inArray(modifierGroups.code, ["BURGER_TEMP", "BURGER_ADDONS", "SALAD_ADDS"])));
  const picks = new Map(
    pickRows.filter((row) => groupOf[row.code] === row.groupCode).map((row) => [row.code, { modifierGroupId: row.modifierGroupId, modifierId: row.modifierId }]),
  );
  const tables = (
    await database
      .select({
        id: restaurantTables.id,
        number: restaurantTables.tableNumber,
        areaType: restaurantAreas.areaType,
        capacity: restaurantTables.capacity,
        minimumCapacity: restaurantTables.minimumCapacity,
      })
      .from(restaurantTables)
      .innerJoin(restaurantAreas, eq(restaurantAreas.id, restaurantTables.restaurantAreaId))
      .where(and(eq(restaurantTables.locationId, owner.locationId), eq(restaurantTables.active, true), eq(restaurantAreas.active, true)))
      .orderBy(asc(restaurantTables.capacity), asc(restaurantTables.tableNumber))
  ).filter((table) => !table.number.startsWith("E2E") && !table.number.startsWith("FCT-") && !table.number.startsWith("PRP-"));
  const profiles = await database
    .select({ id: guestProfiles.id, name: guestProfiles.displayName })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.organizationId, owner.organizationId), eq(guestProfiles.status, "ACTIVE")))
    .orderBy(asc(guestProfiles.displayName));
  const [server] = await database.select({ id: positions.id }).from(positions).where(and(eq(positions.organizationId, owner.organizationId), eq(positions.code, "SERVER")));
  const comp = (await listDiscountDefinitions(database, owner)).find((row) => row.code === "MANAGER_COMP");

  return { items, picks, tables, profiles, serverPositionId: server!.id, compId: comp!.id };
}

/** Receives what the week will use on purchase orders from each supplier, at the week's start. */
async function stockTheWeek(
  database: Database,
  owner: Actor,
  context: ServiceContext,
  checks: Check[],
  receiveAt: Date,
  recipesAt: Date,
): Promise<number> {
  const ids = [...context.items.values()];
  const requirements = await resolveCurrentRequirementsForMenuItems(database, owner.organizationId, ids, recipesAt);
  const effects = await getForecastModifierEffects(database, { organizationId: owner.organizationId, menuItemIds: ids });
  const totals = new Map<string, string>();
  const add = (id: string, quantity: string) => totals.set(id, addDecimals(totals.get(id) ?? "0", quantity));

  for (const check of checks) {
    for (const line of check.lines) {
      const menuItemId = context.items.get(line.code);

      if (!menuItemId) {
        continue;
      }

      for (const requirement of requirements.get(menuItemId) ?? []) {
        add(requirement.inventoryItemId, multiplyExact(requirement.baseQuantity, String(line.quantity)));
      }

      for (const code of line.modifierCodes) {
        const modifierId = context.picks.get(code)?.modifierId;

        for (const effect of effects) {
          if (effect.menuItemId === menuItemId && effect.modifierId === modifierId && effect.operation !== "REMOVE" && compareDecimals(effect.baseQuantity, "0") > 0) {
            add(effect.inventoryItemId, multiplyExact(effect.baseQuantity, String(line.quantity)));
          }
        }
      }
    }
  }

  const inventoryIds = [...totals.keys()];

  if (inventoryIds.length === 0) {
    return 0;
  }

  const onHand = await quantitiesOnHand(database, owner.organizationId, owner.locationId, inventoryIds);
  const supplierRows = await database
    .select({
      id: supplierItems.id,
      supplierId: supplierItems.supplierId,
      inventoryItemId: supplierItems.inventoryItemId,
      baseUnitsPerPurchase: supplierItems.baseUnitsPerPurchase,
      cost: supplierItems.lastUnitCost,
    })
    .from(supplierItems)
    .where(and(inArray(supplierItems.inventoryItemId, inventoryIds), eq(supplierItems.active, true)));
  const baseUnits = new Map(
    (await database.select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId }).from(inventoryItems).where(inArray(inventoryItems.id, inventoryIds))).map((row) => [
      row.id,
      row.baseUnitId,
    ]),
  );
  const bySupplier = new Map<string, { supplierItemId: string; quantity: string }[]>();

  for (const [inventoryItemId, quantity] of totals) {
    const current = onHand.get(inventoryItemId);
    // A quarter more than the week needs, less what is on hand.
    const shortfall = toScale(subtractDecimals(roundHalfUp(multiplyExact(quantity, "1.25"), 4), current?.stocked ? current.quantityOnHand : "0"), 4);

    if (compareDecimals(shortfall, "0") <= 0) {
      continue;
    }

    const supplierItem = supplierRows.find((row) => row.inventoryItemId === inventoryItemId && row.cost !== null);

    if (!supplierItem) {
      await recordAdjustment(database, owner, {
        inventoryItemId,
        direction: "INCREASE",
        reasonCode: "FOUND_STOCK",
        quantity: shortfall,
        unitOfMeasureId: baseUnits.get(inventoryItemId)!,
        notes: "Demo stock for the service history (fake).",
      });
      continue;
    }

    const lines = bySupplier.get(supplierItem.supplierId) ?? [];

    lines.push({ supplierItemId: supplierItem.id, quantity: wholeQuotientCeiling(shortfall, supplierItem.baseUnitsPerPurchase) });
    bySupplier.set(supplierItem.supplierId, lines);
  }

  let created = 0;

  for (const [supplierId, lines] of bySupplier) {
    const order = await createPurchaseOrder(database, owner, { supplierId, expectedAt: receiveAt, notes: "Weekly order (demo history)." });
    let version = order.version;
    const lineIds: { id: string; quantity: string }[] = [];

    for (const line of lines) {
      const added = await addPurchaseOrderLine(database, owner, order.id, {
        supplierItemId: line.supplierItemId,
        orderedQuantity: line.quantity,
        unitPrice: null,
        expectedVersion: version,
      });

      version += 1;
      lineIds.push({ id: added.id, quantity: line.quantity });
    }

    await submitPurchaseOrder(database, owner, order.id, version);
    setClock(receiveAt);
    await receivePurchaseOrder(database, owner, order.id, {
      lines: lineIds.map((line) => ({ purchaseOrderLineId: line.id, receivedQuantity: line.quantity, actualUnitCost: null })),
      supplierReference: `DEMO-WK-${randomUUID().slice(0, 6).toUpperCase()}`,
      notes: null,
    });
    created += 1;
  }

  return created;
}

/** The server on shift at the location at that instant, round robin by the check's number. */
async function serverOnShift(database: Database, owner: Actor, context: ServiceContext, instant: Date, index: number): Promise<string | null> {
  const rows = await database
    .select({ employeeId: shiftAssignments.employeeId })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shifts.locationId, owner.locationId),
        eq(shifts.positionId, context.serverPositionId),
        eq(shiftAssignments.status, "ACTIVE"),
        eq(schedulePeriods.status, "PUBLISHED"),
        lte(shifts.startAt, instant),
        gte(shifts.endAt, new Date(instant.getTime() + 60 * 60_000)),
      ),
    )
    .orderBy(asc(shiftAssignments.employeeId));

  return rows.length === 0 ? null : rows[index % rows.length]!.employeeId;
}

async function serveCheck(
  database: Database,
  owner: Actor,
  context: ServiceContext,
  date: string,
  check: Check,
  at: (date: string, time: string) => Date,
): Promise<void> {
  const start = at(date, check.time);
  const after = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  let sessionId: string | null = null;
  let tableId: string | null = null;

  setClock(start);

  // Only what the operational menu offers right now: an item or modifier on the 86 list is left
  // off, as a server would, and a check left empty gets an offered side instead.
  const offered = new Map(
    (await getOperationalMenu(database, owner, start)).menus
      .flatMap((menu) => menu.categories.flatMap((category) => category.items))
      .map((item) => [item.menuItemId, new Set(item.modifierGroups.flatMap((group) => group.modifiers.map((modifier) => modifier.id)))]),
  );
  let lines = check.lines
    .filter((line) => offered.has(need(context.items, line.code, "menu item")))
    .map((line) => ({
      ...line,
      modifierCodes: line.modifierCodes.filter((code) => offered.get(context.items.get(line.code)!)!.has(need(context.picks, code, "modifier").modifierId)),
    }));

  if (lines.length === 0) {
    const side = ["FRENCH_FRIES", "ONION_RINGS", "FOUNTAIN_SODA"].find((code) => context.items.has(code) && offered.has(context.items.get(code)!));

    if (!side) {
      return;
    }

    lines = [{ code: side, quantity: 1, modifierCodes: [] }];
  }

  if (check.kind !== "TAKEOUT") {
    const area = check.kind === "BAR" ? "BAR" : "DINING";
    // Tables with a party still seated (for example one left from an earlier run) are skipped.
    const busy = new Set(
      (
        await database
          .select({ tableId: tableSessionTables.restaurantTableId })
          .from(tableSessionTables)
          .innerJoin(tableSessions, eq(tableSessions.id, tableSessionTables.tableSessionId))
          .where(and(eq(tableSessions.locationId, owner.locationId), eq(tableSessions.status, "ACTIVE")))
      ).map((row) => row.tableId),
    );
    const free = context.tables.filter((table) => table.areaType === area && !busy.has(table.id));
    const candidates = free.filter(
      (table) => table.capacity >= check.partySize && (table.minimumCapacity === null || table.minimumCapacity <= check.partySize),
    );
    const table = candidates[0] ?? free.at(-1);

    if (!table) {
      throw new Error(`No free ${area.toLowerCase()} table for demo check ${check.key}.`);
    }
    const size = Math.min(check.partySize, table.capacity);
    const serverEmployeeId = check.kind === "DINE_IN" ? await serverOnShift(database, owner, context, start, Number(check.key.split("#")[1])) : null;
    const profile = check.profile !== null ? context.profiles[check.profile] : undefined;

    if (profile) {
      setClock(new Date(start.getTime() - 2 * 86_400_000));

      const reservation = await createReservation(database, owner, {
        guestName: profile.name,
        partySize: size,
        localDate: date,
        localTime: check.time,
        source: "PHONE",
        guestProfileId: profile.id,
      });

      setClock(after(-5));

      const checkedIn = await checkInReservation(database, owner, reservation.id, { expectedVersion: reservation.version });

      setClock(start);

      const seated = await seatReservationParty(database, owner, {
        reservationId: reservation.id,
        expectedVersion: checkedIn.version,
        tableIds: [table.id],
        serverEmployeeId,
      });

      sessionId = seated.id;
    } else {
      sessionId = (await seatParty(database, owner, { tableIds: [table.id], partySize: size, serverEmployeeId })).id;
    }

    tableId = table.id;
  }

  const order = sessionId
    ? await createOrder(database, owner, { orderType: check.kind as "DINE_IN" | "BAR", tableSessionId: sessionId })
    : await createOrder(database, owner, { orderType: "TAKEOUT", customerName: `Takeout ${check.key.split("#")[1]}` });
  let version = order.version;

  for (const line of lines) {
    version = (
      await addDraftItem(database, owner, order.id, {
        expectedVersion: version,
        menuItemId: need(context.items, line.code, "menu item"),
        quantity: line.quantity,
        selections: line.modifierCodes.map((code) => need(context.picks, code, "modifier")),
        specialInstructions: null,
      })
    ).orderVersion;
  }

  setClock(after(4));

  const key = `demo-svc-${order.id}`;

  try {
    await sendOrderItems(database, owner, order.id, { expectedVersion: version, idempotencyKey: key });
  } catch (error) {
    if (!(error instanceof AppError && error.code === "ALLERGEN_ACKNOWLEDGMENT_REQUIRED")) {
      throw error;
    }

    // The server checked with the guest: acknowledge every item and send.
    const drafts = await database.select({ id: orderItems.id }).from(orderItems).where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "DRAFT")));

    await sendOrderItems(database, owner, order.id, {
      expectedVersion: version,
      idempotencyKey: key,
      acknowledgedAllergenItemIds: drafts.map((row) => row.id),
    });
  }

  // A void before the kitchen starts: the guest changed their mind.
  if (check.voidOne) {
    setClock(after(5));

    const [item] = await database
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "SUBMITTED")))
      .orderBy(asc(orderItems.createdAt))
      .limit(1);

    if (item) {
      const [current] = await database.select({ version: orders.version }).from(orders).where(eq(orders.id, order.id));

      await voidOrderItem(database, owner, order.id, item.id, { reason: "Guest changed their mind", disposition: "UNPREPARED", expectedVersion: current!.version });
    }
  }

  // Kitchen and bar work every ticket item through to completed.
  const work = await database
    .select({ id: kitchenTicketItems.id, status: kitchenTicketItems.status, version: kitchenTicketItems.version })
    .from(kitchenTicketItems)
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .where(eq(orderItems.orderId, order.id));
  const offset = Number(check.key.split("#")[1]) % 5;

  for (const ticketItem of work) {
    if (ticketItem.status !== "NEW") {
      continue;
    }

    setClock(after(6 + offset));

    const started = await transitionTicketItem(database, owner, ticketItem.id, "start", { expectedVersion: ticketItem.version });

    setClock(after(16 + offset * 2));

    const ready = await transitionTicketItem(database, owner, ticketItem.id, "ready", { expectedVersion: started.version });

    setClock(after(19 + offset * 2));
    await transitionTicketItem(database, owner, ticketItem.id, "complete", { expectedVersion: ready.version });
  }

  // A manager comp on one item: a long wait.
  if (check.compOne) {
    setClock(after(35));

    const [item] = await database
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "SUBMITTED")))
      .orderBy(asc(orderItems.createdAt))
      .limit(1);
    const [row] = await database.select({ version: orders.version }).from(orders).where(eq(orders.id, order.id));

    if (item) {
      await applyItemDiscount(database, owner, order.id, item.id, { discountDefinitionId: context.compId, reason: "Long wait", expectedVersion: row!.version });
    }
  }

  // Settlement: card or cash, with a tip.
  setClock(after(check.kind === "DINE_IN" ? 55 : check.kind === "BAR" ? 45 : 18));

  const opened = await openSettlement(database, owner, order.id);
  const amount = opened.orderAmountSnapshot;

  if (compareDecimals(amount, "0") > 0) {
    const tip = check.kind === "TAKEOUT" ? "0.00" : roundHalfUp(multiplyExact(amount, String(check.tipPercent / 100)), 2);
    const cash = check.tender === "CASH";
    const received = cash ? `${Number(wholeQuotientCeiling(addDecimals(amount, tip), "5")) * 5}.00` : null;

    await recordTender(database, owner, opened.settlementId, {
      idempotencyKey: `demo-svc-tender-${order.id}`,
      tenderType: cash ? "CASH" : "EXTERNAL_CARD",
      outcome: "RECORDED",
      amount,
      tipAmount: compareDecimals(tip, "0") > 0 ? tip : null,
      receivedAmount: received,
      externalReference: null,
      providerName: null,
      cardBrand: cash ? null : pickFrom(seededRandom(order.id), ["VISA", "MASTERCARD", "AMEX"]),
      cardLastFour: null,
      authorizationReference: null,
      otherDescription: null,
      failureReason: null,
      expectedVersion: opened.settlementVersion,
    });
  }

  const [settled] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, opened.settlementId));

  await completeSettlement(database, owner, opened.settlementId, { expectedVersion: settled!.version, idempotencyKey: `demo-svc-close-${order.id}` });

  if (sessionId && tableId) {
    setClock(after(check.kind === "DINE_IN" ? 62 : 50));

    const [session] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, sessionId));

    await completeTableSession(database, owner, sessionId, { expectedVersion: session!.version });
    setClock(after(check.kind === "DINE_IN" ? 66 : 54));

    const [table] = await database.select({ version: restaurantTables.version, condition: restaurantTables.condition }).from(restaurantTables).where(eq(restaurantTables.id, tableId));

    if (table?.condition === "DIRTY") {
      await cleanTable(database, owner, tableId, { expectedVersion: table.version });
    }
  }
}

// ---------------------------------------------------------- 4. time clock

async function punchShifts(
  database: Database,
  owner: Actor,
  input: {
    first: string;
    yesterday: string;
    today: string;
    at: (date: string, time: string) => Date;
    done: Set<string>;
    record: (key: string) => Promise<void>;
  },
): Promise<number> {
  const rows = await database
    .select({
      assignmentId: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
      positionId: shifts.positionId,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .innerJoin(employees, eq(employees.id, shiftAssignments.employeeId))
    .where(
      and(
        eq(shifts.locationId, owner.locationId),
        eq(shiftAssignments.status, "ACTIVE"),
        eq(schedulePeriods.status, "PUBLISHED"),
        gte(shifts.shiftDate, input.first),
        lte(shifts.shiftDate, input.yesterday),
      ),
    )
    .orderBy(asc(shifts.startAt), asc(shiftAssignments.employeeId));
  // One overtime week: the employee with the most hours in the third week stays later each shift.
  const overtimeWeek = addDays(input.first, 14);
  const weekRows = rows.filter((row) => row.shiftDate >= overtimeWeek && row.shiftDate <= addDays(overtimeWeek, 6));
  const hours = new Map<string, number>();

  for (const row of weekRows) {
    hours.set(row.employeeId, (hours.get(row.employeeId) ?? 0) + (row.endAt.getTime() - row.startAt.getTime()) / 3_600_000);
  }

  const [overtimeEmployee, scheduledHours] = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
  const overtimeShifts = weekRows.filter((row) => row.employeeId === overtimeEmployee).length;
  const extraMinutes = overtimeShifts === 0 ? 0 : Math.min(240, Math.ceil(((42 - scheduledHours) * 60) / overtimeShifts));
  // The missed clock-out: the last shift that ended yesterday.
  const missed = [...rows].reverse().find((row) => row.shiftDate === input.yesterday)?.assignmentId;
  let punched = 0;

  for (const row of rows) {
    const key = `demo.service.punch.${row.assignmentId}`;

    if (input.done.has(key)) {
      continue;
    }

    const random = seededRandom(row.assignmentId);
    const inAt = new Date(row.startAt.getTime() + (between(random, -6, 9)) * 60_000);
    let outAt = new Date(row.endAt.getTime() + between(random, -10, 15) * 60_000);

    if (row.employeeId === overtimeEmployee && row.shiftDate >= overtimeWeek && row.shiftDate <= addDays(overtimeWeek, 6) && extraMinutes > 0) {
      outAt = new Date(row.endAt.getTime() + extraMinutes * 60_000);
    }

    setClock(inAt);

    const code = await codeOf(
      (async () => {
        const entry = await clockIn(database, owner, { employeeId: row.employeeId, positionId: row.positionId, idempotencyKey: `demo-in-${row.assignmentId}` });

        if (row.assignmentId !== missed) {
          const [open] = await database.select({ version: timeEntries.version }).from(timeEntries).where(eq(timeEntries.id, entry.entryId));

          setClock(outAt);
          await clockOut(database, owner, { entryId: entry.entryId, expectedVersion: open!.version, idempotencyKey: `demo-out-${row.assignmentId}` });
        }
      })(),
    );

    if (code === null) {
      punched += 1;
    }

    await input.record(key);
  }

  return punched;
}

// ------------------------------------------------------- 5. front of house

const FIRST_NAMES = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Rowan", "Sage", "Emerson", "Hayden", "Parker", "Reese"];
const LAST_NAMES = ["Nguyen", "Okafor", "Lindqvist", "Moreau", "Haddad", "Kowalski", "Tanaka", "Silva", "Brennan", "Duarte"];

async function upcomingReservations(
  database: Database,
  owner: Actor,
  locationCode: string,
  input: { today: string; timeZone: string; done: Set<string>; record: (key: string) => Promise<void>; profiles: { id: string; name: string }[] },
): Promise<number> {
  const key = `demo.service.upcoming.${input.today}`;

  if (input.done.has(key)) {
    return 0;
  }

  // Online booking at MAIN: evenings, 17:00 to 21:00, if it isn't set up yet.
  const settings = await getOnlineBookingSettings(database, owner);

  if (!settings.enabled) {
    await saveOnlineBookingSettings(database, owner, {
      enabled: true,
      requiresApproval: false,
      maxPartySize: 6,
      minLeadMinutes: 120,
      maxDaysAhead: 30,
      slotIntervalMinutes: 15,
      maxCoversPerSlot: 20,
      reminderHoursBefore: 24,
      publicNote: null,
      expectedVersion: settings.version,
    });
    await replaceBookingPeriods(database, owner, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAt: "17:00", endsAt: "21:00" })));
  }

  let created = 0;

  for (let day = 1; day <= 7; day += 1) {
    const date = addDays(input.today, day);
    const random = seededRandom(`demo-upcoming-${date}`);
    const name = () => `${pickFrom(random, FIRST_NAMES)} ${pickFrom(random, LAST_NAMES)}`;

    for (const time of ["17:30", "18:30", "19:15", "20:00"].slice(0, between(random, 2, 4))) {
      const profile = random() < 0.25 && input.profiles.length > 0 ? pickFrom(random, input.profiles) : null;
      const guestName = profile ? profile.name : name();
      const partySize = between(random, 2, 6);
      const phone = `(555) 1${String(between(random, 0, 99)).padStart(2, "0")}-${String(between(random, 1000, 9999))}`;
      const specialRequests = random() < 0.2 ? "Birthday: a candle with dessert" : null;

      // An interrupted earlier run may have made this one already.
      if (await reservationExists(database, owner, guestName, localToInstant(date, time, timeZoneOf(input))!)) {
        continue;
      }

      await createReservation(database, owner, {
        guestName,
        partySize,
        phone,
        localDate: date,
        localTime: time,
        source: "PHONE",
        guestProfileId: profile?.id ?? null,
        specialRequests,
      });
      created += 1;
    }

    const guest = name();

    await createOnlineReservation(
      database,
      locationCode,
      {
        localDate: date,
        localTime: "19:00",
        partySize: between(random, 2, 4),
        guestName: guest,
        phone: `(555) 2${String(day).padStart(2, "0")}-${String(between(random, 1000, 9999))}`,
        email: `${guest.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
        specialRequests: null,
        messageConsent: { sms: true, email: random() < 0.5 },
        allergies: [],
        website: "",
        idempotencyKey: `demo-online-${date}`,
      },
      { clientIp: null },
    );
    created += 1;
  }

  await input.record(key);

  return created;
}

const timeZoneOf = (input: { timeZone: string }) => input.timeZone;

async function reservationExists(database: Database, owner: Actor, guestName: string, reservationAt: Date): Promise<boolean> {
  const [row] = await database
    .select({ id: reservations.id })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(and(eq(reservations.locationId, owner.locationId), eq(reservations.reservationAt, reservationAt), eq(guestParties.guestName, guestName)));

  return row !== undefined;
}

async function tonightsWaitlist(
  database: Database,
  owner: Actor,
  input: { today: string; done: Set<string>; record: (key: string) => Promise<void> },
): Promise<number> {
  const key = `demo.service.waitlist.${input.today}`;

  if (input.done.has(key)) {
    return 0;
  }

  const parties = [
    { guestName: "Dana Whitfield", partySize: 2, quotedWaitMinutes: 15 },
    { guestName: "Luis Ortega", partySize: 4, quotedWaitMinutes: 25 },
    { guestName: "Priya Raman", partySize: 3, quotedWaitMinutes: 30 },
  ];

  for (const party of parties) {
    await addToWaitlist(database, owner, { ...party, phone: null });
  }

  await input.record(key);

  return parties.length;
}
