import { randomUUID } from "node:crypto";

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Database } from "../../src/db";
import { DEMO_BURGER_GROUPS } from "../../src/db/demo/demo-kitchen";
import { BURGER_KITCHEN_ITEMS, PIZZA_DISHES, PIZZA_GROUPS_DATA } from "../../src/db/demo/pizza/menu";
import {
  employees,
  guestProfiles,
  inventoryItems,
  kitchenTicketItems,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  positions,
  restaurantAreas,
  restaurantTables,
  schedulePeriods,
  settlements,
  shiftAssignments,
  shifts,
  staffingTemplates,
  supplierItems,
  tableSessionTables,
  tableSessions,
  timeEntries,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { quantitiesOnHand } from "../../src/modules/inventory/queries/item-facts";
import { approveCount, getCount, recordCountLine, startCount, submitCount } from "../../src/modules/inventory/services/count-service";
import { addPurchaseOrderLine, createPurchaseOrder, submitPurchaseOrder } from "../../src/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "../../src/modules/inventory/services/receiving-service";
import { recordAdjustment, recordWaste } from "../../src/modules/inventory/services/stock-operations";
import { fireCourse } from "../../src/modules/kitchen/services/course-fire-service";
import { transitionTicketItem } from "../../src/modules/kitchen/services/fulfillment-service";
import { getForecastModifierEffects } from "../../src/modules/menu/queries/forecast-menu";
import { getOperationalMenu } from "../../src/modules/menu/queries/operational-menu";
import { applyItemDiscount, listDiscountDefinitions } from "../../src/modules/orders/services/discount-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { setTaxExemption } from "../../src/modules/orders/services/tax-exemption-service";
import { resolveCurrentRequirementsForMenuItems } from "../../src/modules/recipes/queries/menu-item-requirements";
import { checkInReservation, createReservation } from "../../src/modules/reservations/services/reservation-service";
import { cleanTable } from "../../src/modules/restaurant/services/table-service";
import { applyTemplate } from "../../src/modules/scheduling/services/config-service";
import { runGeneration } from "../../src/modules/scheduling/services/generation-service";
import { createPeriod, publishPeriod } from "../../src/modules/scheduling/services/schedule-service";
import { clockIn, clockOut } from "../../src/modules/scheduling/services/timeclock-service";
import { closeDrawerSession, createDrawer, getDrawerSetting, listDrawerSessions, listDrawers, openDrawerSession } from "../../src/modules/settlements/services/drawer-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { declareTips } from "../../src/modules/settlements/services/tip-declaration-service";
import { addDecimals, compareDecimals, multiplyExact, roundHalfUp, subtractDecimals, toScale, wholeQuotientCeiling } from "../../src/shared/decimal/decimal";
import { AppError } from "../../src/shared/errors/app-error";
import { addDays, dayOfWeek } from "../../src/shared/time/zoned-time";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../../src/workflows/end-table-session/end-table-session";
import { finalizeTipDistribution } from "../../src/workflows/finalize-tip-distribution/finalize-tip-distribution";
import { seatReservationParty } from "../../src/workflows/seat-guest-party/seat-guest-party";
import { seatParty } from "../../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";
import { voidOrderItem } from "../../src/workflows/void-order-item/void-order-item";

import { installShiftedClock, restoreClock, setClock } from "./clock";
import { between, codeOf, need, pickFrom, seededRandom, timeOf } from "./helpers";
import { PIZZA_TEMPLATE_NAME } from "./staff";

// Six weeks of service at MAIN through the real services, with this script's clock moved back,
// so ledgers, snapshots, tickets, settlements, schedules and tip pools all agree:
//   - weekly schedules from "Pizza week", generated and published before each week (next week
//     is left as a draft for a manager to review);
//   - daily dine-in (by seat, some tables coursed: starters first, mains fired after), bar tabs
//     and takeout (the pizza share), from the operational menu; voids, comps and a weekly tax
//     exempt check; card or cash with tips into a drawer; tickets worked; tables cleaned;
//     some parties from reservations linked to guest profiles;
//   - stock on purchase orders each week, sized to the week, a Monday count of the proteins and
//     cheese, and Sunday night waste;
//   - time clock punches (one overtime week, one missed clock-out yesterday), cash tip
//     declarations by bartenders, and each day's tip pool finalized through two days ago.
// Idempotent: every unit of work records a `seed_runs` key, and a rerun skips what is recorded.

export const HISTORY_DAYS = 42;
const DAY_FACTOR = [1.1, 0.7, 0.75, 0.85, 1.0, 1.35, 1.45] as const;
const KEY = "demo.pizza";

type Line = { code: string; quantity: number; modifierCodes: string[]; course: number };
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
  coursed: boolean;
  taxExempt: boolean;
  /** Index into the guest profiles, for a reservation visit. */
  profile: number | null;
  customerName: string | null;
};

const PIZZAS = [
  "CHEESE_PIZZA", "CHEESE_PIZZA", "PEPPERONI_PIZZA", "PEPPERONI_PIZZA", "PEPPERONI_PIZZA", "MARGHERITA_PIZZA", "SAUSAGE_PEPPERS_PIZZA",
  "SUPREME_PIZZA", "SUPREME_PIZZA", "MEAT_LOVERS_PIZZA", "BBQ_CHICKEN_PIZZA", "BUFFALO_CHICKEN_PIZZA", "VEGGIE_PIZZA", "WHITE_PIZZA", "CALZONE", "STROMBOLI",
] as const;
const OTHER_MAINS = [
  "ITALIAN_SUB", "MEATBALL_SUB", "CHICKEN_PARM_SUB", "CHICKEN_PARM_SUB", "PHILLY_CHEESESTEAK", "TURKEY_CLUB", "VEGGIE_PANINI",
  "BACON_CHEESEBURGER", "BACON_CHEESEBURGER", "CAESAR_SALAD", "GARDEN_SALAD", "ANTIPASTO_SALAD",
] as const;
const STARTERS = ["GARLIC_KNOTS", "GARLIC_KNOTS", "CHEESY_BREAD", "MOZZARELLA_STICKS", "BUFFALO_WINGS", "BUFFALO_WINGS", "FRIED_CALAMARI", "LOADED_FRIES", "BRUSCHETTA", "FRENCH_FRIES"] as const;
const DESSERTS = ["CANNOLI", "CANNOLI", "TIRAMISU"] as const;
const DRINKS = [
  "DRAFT_LAGER", "DRAFT_LAGER", "HOUSE_IPA", "SEASONAL_DRAFT", "DOMESTIC_BOTTLE", "IMPORT_BOTTLE", "CHIANTI_GLASS", "PINOT_GRIGIO_GLASS", "CABERNET_GLASS",
  "MARGARITA", "APEROL_SPRITZ", "FOUNTAIN_SODA", "FOUNTAIN_SODA", "ICED_TEA", "LEMONADE", "ITALIAN_SODA",
] as const;
const BAR_DRINKS = [
  "DRAFT_LAGER", "DRAFT_LAGER", "HOUSE_IPA", "HOUSE_IPA", "SEASONAL_DRAFT", "IMPORT_BOTTLE", "MARGARITA", "OLD_FASHIONED", "NEGRONI", "APEROL_SPRITZ",
  "MOSCOW_MULE", "ESPRESSO_MARTINI", "TITOS_GIMLET", "WHISKEY_POUR", "VODKA_POUR", "CHIANTI_GLASS", "PROSECCO_GLASS",
] as const;
const FIRST_NAMES = ["Avery", "Jordan", "Riley", "Casey", "Quinn", "Rowan", "Sage", "Emerson", "Hayden", "Parker", "Reese", "Devon", "Kai", "Logan"];
const LAST_INITIALS = ["N.", "O.", "L.", "M.", "H.", "K.", "T.", "S.", "B.", "D.", "R.", "W."];

/** One dish with modifiers chosen the way guests order. */
function lineFor(random: () => number, code: string, course = 1): Line {
  const mods: string[] = [];

  if ((PIZZAS as readonly string[]).includes(code) && code !== "CALZONE" && code !== "STROMBOLI") {
    const glutenFree = random() < 0.04;

    mods.push(glutenFree ? "SIZE_10" : pickFrom(random, ["SIZE_10", "SIZE_14", "SIZE_14", "SIZE_14", "SIZE_16", "SIZE_16"]));

    if (glutenFree) {
      mods.push("CRUST_GLUTEN_FREE");
    } else if (random() < 0.08) {
      mods.push("CRUST_THIN");
    }

    const toppings = random() < 0.12 ? 2 : random() < 0.3 ? 1 : 0;

    for (const topping of ["TOP_MUSHROOM", "TOP_EXTRA_CHEESE", "TOP_JALAPENO", "TOP_SAUSAGE", "TOP_BACON", "TOP_ONION", "TOP_BLACK_OLIVE", "TOP_GREEN_PEPPER", "TOP_PEPPERONI"].slice(0, 9)) {
      if (mods.filter((mod) => mod.startsWith("TOP_")).length < toppings && random() < 0.3) {
        mods.push(topping);
      }
    }
  } else if (code === "CALZONE") {
    mods.push(pickFrom(random, ["TOP_PEPPERONI", "TOP_SAUSAGE", "TOP_MUSHROOM", "TOP_BACON"]));
  } else if (["ITALIAN_SUB", "MEATBALL_SUB", "CHICKEN_PARM_SUB", "PHILLY_CHEESESTEAK", "TURKEY_CLUB", "VEGGIE_PANINI"].includes(code)) {
    mods.push(pickFrom(random, ["SIDE_FRIES", "SIDE_FRIES", "SIDE_FRIES", "SIDE_SALAD", "SIDE_CHIPS"]));
  } else if (code === "BACON_CHEESEBURGER") {
    mods.push(pickFrom(random, ["TEMP_MEDIUM", "TEMP_MEDIUM", "TEMP_MEDIUM_RARE", "TEMP_WELL_DONE"]));

    if (random() < 0.2) {
      mods.push("EXTRA_PICKLES");
    }
  } else if (["CAESAR_SALAD", "GARDEN_SALAD", "ANTIPASTO_SALAD"].includes(code)) {
    if (random() < 0.4) {
      mods.push("ADD_GRILLED_CHICKEN");
    } else if (code !== "ANTIPASTO_SALAD" && random() < 0.1) {
      mods.push("NO_CROUTONS");
    }
  } else if (code === "WHISKEY_POUR" || code === "VODKA_POUR") {
    mods.push(random() < 0.4 ? "CALL_POUR" : "WELL_POUR");
  }

  return { code, quantity: 1, modifierCodes: mods.sort(), course };
}

/** One day's checks, the same on every run. */
export function planFor(date: string, profileCount: number): Check[] {
  const random = seededRandom(`demo-pizza-${date}`);
  const factor = DAY_FACTOR[dayOfWeek(date)]!;
  const checks: Check[] = [];
  const add = (time: number, kind: Kind, partySize: number, lines: Line[], extra: Partial<Check> = {}) => {
    const merged = new Map<string, Line>();

    for (const line of lines) {
      const key = `${line.code}|${line.modifierCodes.join(",")}|${line.course}`;
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
      tender: random() < 0.22 ? "CASH" : "CARD",
      tipPercent: pickFrom(random, [15, 18, 18, 20, 20, 22]),
      voidOne: itemCount >= 3 && random() < 0.05,
      compOne: itemCount >= 3 && random() < 0.04,
      coursed: false,
      taxExempt: false,
      profile: null,
      customerName: null,
      ...extra,
    });
  };
  const table = (size: number, coursed: boolean) => {
    const lines: Line[] = [];
    const mainCourse = coursed ? 2 : 1;

    for (let pizza = 0; pizza < Math.ceil(size / 2); pizza += 1) {
      lines.push(lineFor(random, pickFrom(random, PIZZAS), mainCourse));
    }

    for (let guest = 0; guest < size; guest += 1) {
      if (random() < 0.3) {
        lines.push(lineFor(random, pickFrom(random, OTHER_MAINS), mainCourse));
      }

      if (random() < 0.7) {
        lines.push(lineFor(random, pickFrom(random, DRINKS), 1));
      }
    }

    if (coursed || random() < 0.5) {
      lines.push(lineFor(random, pickFrom(random, STARTERS), 1));
    }

    if (random() < 0.25) {
      lines.push(lineFor(random, pickFrom(random, DESSERTS), mainCourse));
    }

    return lines;
  };
  const dineIn = (time: number, low: number, high: number, extra: Partial<Check> = {}) => {
    const size = between(random, low, high);
    const coursed = size >= 2 && random() < 0.35;

    add(time, "DINE_IN", size, table(size, coursed), { coursed, ...extra });
  };

  for (let index = 0; index < Math.round(4 * factor); index += 1) {
    dineIn(11 * 60 + 15 + index * 40 + between(random, 0, 15), 1, 4);
  }

  for (let index = 0; index < Math.round(9 * factor); index += 1) {
    const profile = profileCount > 0 && random() < 0.15 ? between(random, 0, profileCount - 1) : null;

    // Wednesday's first dinner table is a school fundraiser group, exempt from sales tax.
    dineIn(17 * 60 + index * 22 + between(random, 0, 12), 2, 6, { profile, taxExempt: dayOfWeek(date) === 3 && index === 0 });
  }

  for (let index = 0; index < Math.round(4 * factor); index += 1) {
    const size = between(random, 1, 2);
    const lines: Line[] = [];

    for (let guest = 0; guest < size; guest += 1) {
      for (let round = 0; round < between(random, 1, 3); round += 1) {
        lines.push(lineFor(random, pickFrom(random, BAR_DRINKS)));
      }
    }

    if (random() < 0.4) {
      lines.push(lineFor(random, pickFrom(random, STARTERS)));
    }

    if (random() < 0.25) {
      lines.push({ ...lineFor(random, pickFrom(random, ["PEPPERONI_PIZZA", "CHEESE_PIZZA", "MARGHERITA_PIZZA"])), modifierCodes: ["SIZE_10"] });
    }

    add(15 * 60 + 30 + index * 45 + between(random, 0, 20), "BAR", size, lines);
  }

  for (let index = 0; index < Math.round(8 * factor); index += 1) {
    const lines: Line[] = [];

    for (let pizza = 0; pizza < between(random, 1, 3); pizza += 1) {
      lines.push(lineFor(random, pickFrom(random, PIZZAS)));
    }

    if (random() < 0.3) {
      lines.push(lineFor(random, pickFrom(random, OTHER_MAINS)));
    }

    if (random() < 0.45) {
      lines.push(lineFor(random, pickFrom(random, ["GARLIC_KNOTS", "BUFFALO_WINGS", "CHEESY_BREAD", "MOZZARELLA_STICKS"])));
    }

    if (random() < 0.2) {
      lines.push(lineFor(random, pickFrom(random, ["LEMONADE", "CANNOLI"])));
    }

    const lunch = index < Math.round(8 * factor) / 3;
    const time = lunch ? 11 * 60 + 30 + index * 35 : 16 * 60 + 30 + index * 25;

    add(time + between(random, 0, 15), "TAKEOUT", 1, lines, {
      tipPercent: 0,
      customerName: `${pickFrom(random, FIRST_NAMES)} ${pickFrom(random, LAST_INITIALS)}`,
    });
  }

  return checks.sort((a, b) => a.time.localeCompare(b.time));
}

// ------------------------------------------------------------------------ the seed

export type HistorySummary = {
  periods: number;
  unfilledShifts: number;
  checks: number;
  purchaseOrders: number;
  counts: number;
  wasteDays: number;
  punches: number;
  declarations: number;
  tipDays: number;
};

type ServiceContext = {
  items: Map<string, string>;
  picks: Map<string, { modifierGroupId: string; modifierId: string }>;
  tables: { id: string; areaType: string; capacity: number; minimumCapacity: number | null }[];
  profiles: { id: string; name: string }[];
  serverPositionId: string;
  compId: string;
  drawerSessionId: string | null;
  /** What the operational menu offers, read once per served date (nothing is 86'd in the history). */
  offered: { date: string; items: Map<string, Set<string>> } | null;
};

export async function seedPizzaHistory(
  database: Database,
  owner: Actor,
  input: { today: string; first: string; at: (date: string, time: string) => Date; done: Set<string>; record: (key: string) => Promise<void> },
): Promise<HistorySummary> {
  const { today, first, at, done, record } = input;
  const yesterday = addDays(today, -1);
  const summary: HistorySummary = { periods: 0, unfilledShifts: 0, checks: 0, purchaseOrders: 0, counts: 0, wasteDays: 0, punches: 0, declarations: 0, tipDays: 0 };

  installShiftedClock();

  try {
    // --------------------------------------------------------- 1. schedules
    const [template] = await database
      .select({ id: staffingTemplates.id })
      .from(staffingTemplates)
      .where(and(eq(staffingTemplates.locationId, owner.locationId), eq(staffingTemplates.name, PIZZA_TEMPLATE_NAME)));

    if (!template) {
      throw new Error(`The "${PIZZA_TEMPLATE_NAME}" template is missing; the staff step runs first.`);
    }

    for (let week = first; week <= addDays(today, 7); week = addDays(week, 7)) {
      const key = `${KEY}.period.${week}`;

      if (done.has(key)) {
        continue;
      }

      const end = addDays(week, 6);
      const [overlap] = await database
        .select({ id: schedulePeriods.id })
        .from(schedulePeriods)
        .where(and(eq(schedulePeriods.locationId, owner.locationId), lte(schedulePeriods.startDate, end), gte(schedulePeriods.endDate, week)));

      if (!overlap) {
        const future = week > today;

        if (future) {
          restoreClock();
        } else {
          setClock(at(addDays(week, -3), "10:00"));
        }

        const period = await createPeriod(database, owner, { name: `Week of ${week}`, startDate: week, endDate: end });
        const applied = await applyTemplate(database, owner, period.id, { templateId: template.id, expectedPeriodVersion: period.version });

        await runGeneration(database, owner, period.id, { mode: "GENERATE_DRAFT", expectedVersion: applied.periodVersion });
        summary.unfilledShifts += await unfilledShifts(database, period.id);

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

    // ------------------------------------------- 2. service, with weekly stock
    const context = await serviceContext(database, owner);

    for (let week = first; week <= yesterday; week = addDays(week, 7)) {
      const dates: string[] = [];

      for (let date = week; date <= addDays(week, 6) && date <= yesterday; date = addDays(date, 1)) {
        dates.push(date);
      }

      const plans = dates.map((date) => ({ date, checks: planFor(date, context.profiles.length).filter((check) => !done.has(`${KEY}.check.${check.key}`)) }));

      if (plans.every((plan) => plan.checks.length === 0)) {
        continue;
      }

      const firstDay = plans.find((plan) => plan.checks.length > 0)!.date;
      const lastDay = plans.at(-1)!.date;

      setClock(at(firstDay, "08:30"));
      summary.purchaseOrders += await stockTheWeek(database, owner, context, plans.flatMap((plan) => plan.checks), at(firstDay, "09:00"), at(lastDay, "23:00"));

      for (const plan of plans) {
        if (dayOfWeek(plan.date) === 1 && !done.has(`${KEY}.count.${plan.date}`)) {
          setClock(at(plan.date, "09:30"));
          summary.counts += await weeklyCount(database, owner, plan.date);
          await record(`${KEY}.count.${plan.date}`);
        }

        context.drawerSessionId = plan.checks.length > 0 ? await openDemoDrawer(database, owner, plan.date, at) : null;

        for (const check of plan.checks) {
          try {
            await serveCheck(database, owner, context, plan.date, check, at);
          } catch (error) {
            console.error(`Demo check ${check.key} (${check.kind} at ${check.time}) failed.`);
            throw error;
          }

          await record(`${KEY}.check.${check.key}`);
          summary.checks += 1;
        }

        await closeDemoDrawer(database, owner, context, plan.date, at);

        if (dayOfWeek(plan.date) === 0 && !done.has(`${KEY}.waste.${plan.date}`)) {
          setClock(at(plan.date, "22:30"));
          await sundayWaste(database, owner);
          await record(`${KEY}.waste.${plan.date}`);
          summary.wasteDays += 1;
        }
      }
    }

    // -------------------------------------- 3. punches, declarations, tips
    const punched = await punchShifts(database, owner, { first, yesterday, today, done, record });

    summary.punches += punched.punches;
    summary.declarations += punched.declarations;

    for (let date = first; date <= addDays(today, -2); date = addDays(date, 1)) {
      const key = `${KEY}.tips.${date}`;

      if (done.has(key)) {
        continue;
      }

      setClock(at(addDays(date, 1), "10:00"));

      const code = await codeOf(finalizeTipDistribution(database, owner, { businessDate: date, idempotencyKey: `demo-pizza-tips-${date}` }));

      if (code === null) {
        summary.tipDays += 1;
      } else if (code !== "TIP_DISTRIBUTION_FINALIZED") {
        console.warn(`Demo tips for ${date} not finalized (${code}).`);
        continue;
      }

      await record(key);
    }
  } finally {
    restoreClock();
  }

  return summary;
}

/** Template slots the generator left without enough people. */
async function unfilledShifts(database: Database, periodId: string): Promise<number> {
  const rows = await database
    .select({ id: shifts.id, required: shifts.requiredEmployeeCount, assignmentId: shiftAssignments.id, status: shiftAssignments.status })
    .from(shifts)
    .leftJoin(shiftAssignments, eq(shiftAssignments.shiftId, shifts.id))
    .where(eq(shifts.schedulePeriodId, periodId));
  const byShift = new Map<string, { required: number; filled: number }>();

  for (const row of rows) {
    const entry = byShift.get(row.id) ?? { required: row.required, filled: 0 };

    if (row.assignmentId && row.status === "ACTIVE") {
      entry.filled += 1;
    }

    byShift.set(row.id, entry);
  }

  return [...byShift.values()].reduce((sum, entry) => sum + Math.max(0, entry.required - entry.filled), 0);
}

// ------------------------------------------------------------------ helpers

async function serviceContext(database: Database, owner: Actor): Promise<ServiceContext> {
  const codes = [...PIZZA_DISHES.map((dish) => dish.code), ...BURGER_KITCHEN_ITEMS];
  const items = new Map(
    (await database.select({ id: menuItems.id, code: menuItems.code }).from(menuItems).where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, codes)))).map(
      (row) => [row.code, row.id],
    ),
  );
  const groupOf = new Map<string, string>();

  for (const group of [...PIZZA_GROUPS_DATA, ...DEMO_BURGER_GROUPS]) {
    for (const modifier of group.modifiers) {
      groupOf.set(modifier.code, group.code);
    }
  }

  const pickRows = await database
    .select({ code: modifiers.code, modifierId: modifiers.id, modifierGroupId: modifierGroups.id, groupCode: modifierGroups.code })
    .from(modifiers)
    .innerJoin(modifierGroups, eq(modifierGroups.organizationId, modifiers.organizationId))
    .where(and(eq(modifiers.organizationId, owner.organizationId), inArray(modifierGroups.code, [...new Set(groupOf.values())])));
  const picks = new Map(pickRows.filter((row) => groupOf.get(row.code) === row.groupCode).map((row) => [row.code, { modifierGroupId: row.modifierGroupId, modifierId: row.modifierId }]));
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
  ).filter((table) => /^[TB]\d+$/.test(table.number));
  const profiles = await database
    .select({ id: guestProfiles.id, name: guestProfiles.displayName })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.organizationId, owner.organizationId), eq(guestProfiles.status, "ACTIVE")))
    .orderBy(asc(guestProfiles.displayName));
  const [server] = await database.select({ id: positions.id }).from(positions).where(and(eq(positions.organizationId, owner.organizationId), eq(positions.code, "SERVER")));
  const comp = (await listDiscountDefinitions(database, owner)).find((row) => row.code === "MANAGER_COMP");

  return { items, picks, tables, profiles, serverPositionId: server!.id, compId: comp!.id, drawerSessionId: null, offered: null };
}

/** When the location requires a drawer for cash: one drawer session per served day, closed at the expected count. */
async function openDemoDrawer(database: Database, owner: Actor, date: string, at: (date: string, time: string) => Date): Promise<string | null> {
  if (!(await getDrawerSetting(database, owner)).required) {
    return null;
  }

  const [open] = await listDrawerSessions(database, owner, { status: "OPEN", limit: 1 });

  if (open) {
    return open.id;
  }

  const drawer = (await listDrawers(database, owner)).find((row) => row.code === "FRONT") ?? (await createDrawer(database, owner, { code: "FRONT", name: "Front counter" }));

  setClock(at(date, "10:15"));

  return (await openDrawerSession(database, owner, drawer.id, { openingFloat: "200.00", idempotencyKey: `demo-pizza-drawer-open-${date}` })).id;
}

async function closeDemoDrawer(database: Database, owner: Actor, context: ServiceContext, date: string, at: (date: string, time: string) => Date): Promise<void> {
  if (!context.drawerSessionId) {
    return;
  }

  const [session] = await listDrawerSessions(database, owner, { status: "OPEN", limit: 1 });

  if (session) {
    setClock(at(addDays(date, 1), "01:45"));
    await closeDrawerSession(database, owner, session.id, {
      countedAmount: session.totals.expected,
      closeNote: null,
      expectedVersion: session.version,
      idempotencyKey: `demo-pizza-drawer-close-${date}`,
    });
  }

  context.drawerSessionId = null;
}

/** Receives what the week will use (a quarter more, less what is on hand) from each supplier. */
async function stockTheWeek(database: Database, owner: Actor, context: ServiceContext, checks: Check[], receiveAt: Date, recipesAt: Date): Promise<number> {
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

  return receiveShortfalls(database, owner, totals, "1.25", receiveAt, "Weekly order (demo history).");
}

/**
 * Orders `factor` times each quantity, less what is on hand, on one purchase order per supplier,
 * and receives it at `receiveAt`. Items without a costed supplier item are topped up by a
 * found-stock adjustment instead. Returns how many purchase orders it received.
 */
export async function receiveShortfalls(
  database: Database,
  owner: Actor,
  totals: Map<string, string>,
  factor: string,
  receiveAt: Date,
  note: string,
): Promise<number> {
  const inventoryIds = [...totals.keys()];

  if (inventoryIds.length === 0) {
    return 0;
  }

  const onHand = await quantitiesOnHand(database, owner.organizationId, owner.locationId, inventoryIds);
  const supplierRows = await database
    .select({ id: supplierItems.id, supplierId: supplierItems.supplierId, inventoryItemId: supplierItems.inventoryItemId, baseUnitsPerPurchase: supplierItems.baseUnitsPerPurchase, cost: supplierItems.lastUnitCost })
    .from(supplierItems)
    .where(and(inArray(supplierItems.inventoryItemId, inventoryIds), eq(supplierItems.active, true)));
  const baseUnits = new Map(
    (await database.select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId }).from(inventoryItems).where(inArray(inventoryItems.id, inventoryIds))).map((row) => [row.id, row.baseUnitId]),
  );
  const bySupplier = new Map<string, { supplierItemId: string; quantity: string }[]>();

  for (const [inventoryItemId, quantity] of totals) {
    const current = onHand.get(inventoryItemId);
    const shortfall = toScale(subtractDecimals(roundHalfUp(multiplyExact(quantity, factor), 4), current?.stocked ? current.quantityOnHand : "0"), 4);

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
        notes: "Demo stock (fake).",
      });
      continue;
    }

    const lines = bySupplier.get(supplierItem.supplierId) ?? [];

    lines.push({ supplierItemId: supplierItem.id, quantity: wholeQuotientCeiling(shortfall, supplierItem.baseUnitsPerPurchase) });
    bySupplier.set(supplierItem.supplierId, lines);
  }

  let created = 0;

  for (const [supplierId, lines] of bySupplier) {
    const order = await createPurchaseOrder(database, owner, { supplierId, expectedAt: receiveAt, notes: note });
    let version = order.version;
    const lineIds: { id: string; quantity: string }[] = [];

    for (const line of lines) {
      const added = await addPurchaseOrderLine(database, owner, order.id, { supplierItemId: line.supplierItemId, orderedQuantity: line.quantity, unitPrice: null, expectedVersion: version });

      version += 1;
      lineIds.push({ id: added.id, quantity: line.quantity });
    }

    await submitPurchaseOrder(database, owner, order.id, version);
    await receivePurchaseOrder(database, owner, order.id, {
      lines: lineIds.map((line) => ({ purchaseOrderLineId: line.id, receivedQuantity: line.quantity, actualUnitCost: null })),
      supplierReference: `INV-${randomUUID().slice(0, 6).toUpperCase()}`,
      notes: null,
    });
    created += 1;
  }

  return created;
}

const COUNT_ITEMS = ["MOZZARELLA", "PEPPERONI", "ITALIAN_SAUSAGE", "HAM", "CHICKEN_BREAST", "SHAVED_STEAK", "PROVOLONE", "PIZZA_DOUGH"] as const;

/** Monday's count of the cheese, proteins and dough: a little short on two items, approved. */
async function weeklyCount(database: Database, owner: Actor, date: string): Promise<number> {
  const ids = (await database.select({ id: inventoryItems.id }).from(inventoryItems).where(and(eq(inventoryItems.organizationId, owner.organizationId), inArray(inventoryItems.code, [...COUNT_ITEMS])))).map(
    (row) => row.id,
  );
  const count = await startCount(database, owner, { name: `Monday count ${date}`, inventoryItemIds: ids });
  const random = seededRandom(`demo-count-${date}`);
  const detail = await getCount(database, owner, count.id);

  for (const line of detail.lines) {
    const short = (line.itemCode === "MOZZARELLA" || line.itemCode === "PEPPERONI") && compareDecimals(line.expectedQuantity, "20") > 0;
    const counted = short ? toScale(subtractDecimals(line.expectedQuantity, String(between(random, 2, 6))), 4) : line.expectedQuantity;

    await recordCountLine(database, owner, count.id, line.id, { countedQuantity: counted, notes: short ? "Short against the system" : null, expectedVersion: line.version });
  }

  const submitted = await submitCount(database, owner, count.id, (await getCount(database, owner, count.id)).count.version);

  await approveCount(database, owner, count.id, { expectedVersion: submitted.version, acknowledgeActivity: true });

  return 1;
}

/** Sunday close: trimmed dough and some wilted greens thrown out. */
async function sundayWaste(database: Database, owner: Actor): Promise<void> {
  const rows = await database
    .select({ id: inventoryItems.id, code: inventoryItems.code, baseUnitId: inventoryItems.baseUnitId })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, owner.organizationId), inArray(inventoryItems.code, ["PIZZA_DOUGH", "MIXED_GREENS"])));

  for (const row of rows) {
    await codeOf(
      recordWaste(database, owner, {
        inventoryItemId: row.id,
        quantity: row.code === "PIZZA_DOUGH" ? "24" : "6",
        unitOfMeasureId: row.baseUnitId,
        reasonCode: row.code === "PIZZA_DOUGH" ? "PREP_WASTE" : "SPOILAGE",
        notes: row.code === "PIZZA_DOUGH" ? "Over-proofed dough balls" : "Wilted greens",
      }),
    );
  }
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

async function workTickets(database: Database, owner: Actor, orderId: string, after: (minutes: number) => Date, offset: number, startAt: number): Promise<void> {
  const work = await database
    .select({ id: kitchenTicketItems.id, status: kitchenTicketItems.status, version: kitchenTicketItems.version })
    .from(kitchenTicketItems)
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .where(eq(orderItems.orderId, orderId));

  for (const ticketItem of work) {
    if (ticketItem.status !== "NEW") {
      continue;
    }

    setClock(after(startAt + offset));

    const started = await codeOfResult(transitionTicketItem(database, owner, ticketItem.id, "start", { expectedVersion: ticketItem.version }));

    // A held course's items can't start yet; they are worked after it is fired.
    if (!started) {
      continue;
    }

    setClock(after(startAt + 10 + offset * 2));

    const ready = await transitionTicketItem(database, owner, ticketItem.id, "ready", { expectedVersion: started.version });

    setClock(after(startAt + 13 + offset * 2));
    await transitionTicketItem(database, owner, ticketItem.id, "complete", { expectedVersion: ready.version });
  }
}

async function codeOfResult<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof AppError) {
      return null;
    }

    throw error;
  }
}

async function orderVersion(database: Database, orderId: string): Promise<number> {
  const [row] = await database.select({ version: orders.version }).from(orders).where(eq(orders.id, orderId));

  return row!.version;
}

async function serveCheck(database: Database, owner: Actor, context: ServiceContext, date: string, check: Check, at: (date: string, time: string) => Date): Promise<void> {
  const start = at(date, check.time);
  const after = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const number = Number(check.key.split("#")[1]);
  let sessionId: string | null = null;
  let tableId: string | null = null;

  setClock(start);

  // Only what the operational menu offers that day; a check left empty gets garlic knots.
  if (context.offered?.date !== date) {
    context.offered = {
      date,
      items: new Map(
        (await getOperationalMenu(database, owner, start)).menus
          .flatMap((menu) => menu.categories.flatMap((category) => category.items))
          .map((item) => [item.menuItemId, new Set(item.modifierGroups.flatMap((group) => group.modifiers.map((modifier) => modifier.id)))]),
      ),
    };
  }

  const offered = context.offered.items;
  let lines = check.lines
    .filter((line) => offered.has(need(context.items, line.code, "menu item")))
    .filter((line) => line.modifierCodes.every((code) => offered.get(context.items.get(line.code)!)!.has(need(context.picks, code, "modifier").modifierId)));

  if (lines.length === 0) {
    const side = ["GARLIC_KNOTS", "FRENCH_FRIES", "FOUNTAIN_SODA"].find((code) => context.items.has(code) && offered.has(context.items.get(code)!));

    if (!side) {
      return;
    }

    lines = [{ code: side, quantity: 1, modifierCodes: [], course: 1 }];
  }

  const coursed = check.coursed && new Set(lines.map((line) => line.course)).size > 1;

  if (check.kind !== "TAKEOUT") {
    const area = check.kind === "BAR" ? "BAR" : "DINING";
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
    const table = free.find((entry) => entry.capacity >= check.partySize && (entry.minimumCapacity === null || entry.minimumCapacity <= check.partySize)) ?? free.at(-1);

    if (!table) {
      throw new Error(`No free ${area.toLowerCase()} table for demo check ${check.key}.`);
    }

    const size = Math.min(check.partySize, table.capacity);
    const serverEmployeeId = check.kind === "DINE_IN" ? await serverOnShift(database, owner, context, start, number) : null;
    const profile = check.profile !== null ? context.profiles[check.profile] : undefined;

    if (profile) {
      setClock(new Date(start.getTime() - 2 * 86_400_000));

      const reservation = await createReservation(database, owner, { guestName: profile.name, partySize: size, localDate: date, localTime: check.time, source: "PHONE", guestProfileId: profile.id });

      setClock(after(-5));

      const checkedIn = await checkInReservation(database, owner, reservation.id, { expectedVersion: reservation.version });

      setClock(start);
      sessionId = (await seatReservationParty(database, owner, { reservationId: reservation.id, expectedVersion: checkedIn.version, tableIds: [table.id], serverEmployeeId })).id;
    } else {
      sessionId = (await seatParty(database, owner, { tableIds: [table.id], partySize: size, serverEmployeeId })).id;
    }

    tableId = table.id;
  }

  const order = sessionId
    ? await createOrder(database, owner, { orderType: check.kind as "DINE_IN" | "BAR", tableSessionId: sessionId })
    : await createOrder(database, owner, { orderType: "TAKEOUT", customerName: check.customerName ?? `Takeout ${number}` });
  let version = order.version;

  for (const [index, line] of lines.entries()) {
    version = (
      await addDraftItem(database, owner, order.id, {
        expectedVersion: version,
        menuItemId: need(context.items, line.code, "menu item"),
        quantity: line.quantity,
        selections: line.modifierCodes.map((code) => need(context.picks, code, "modifier")),
        specialInstructions: null,
        courseNumber: coursed ? line.course : 1,
        // Dining room lines are rung by seat, in turn around the table.
        seatNumber: check.kind === "DINE_IN" ? (index % Math.max(1, check.partySize)) + 1 : null,
      })
    ).orderVersion;
  }

  setClock(after(3));

  const key = `demo-pizza-${order.id}`;
  const fire = coursed ? ("FIRST_COURSE" as const) : ("ALL" as const);

  try {
    await sendOrderItems(database, owner, order.id, { expectedVersion: version, idempotencyKey: key, fire });
  } catch (error) {
    if (!(error instanceof AppError && error.code === "ALLERGEN_ACKNOWLEDGMENT_REQUIRED")) {
      throw error;
    }

    // The server checked with the guest: acknowledge every item and send.
    const drafts = await database.select({ id: orderItems.id }).from(orderItems).where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "DRAFT")));

    await sendOrderItems(database, owner, order.id, { expectedVersion: version, idempotencyKey: key, fire, acknowledgedAllergenItemIds: drafts.map((row) => row.id) });
  }

  if (check.voidOne) {
    setClock(after(4));

    const [item] = await database
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "SUBMITTED")))
      .orderBy(asc(orderItems.createdAt))
      .limit(1);

    if (item) {
      await voidOrderItem(database, owner, order.id, item.id, { reason: "Guest changed their mind", disposition: "UNPREPARED", expectedVersion: await orderVersion(database, order.id) });
    }
  }

  const offset = number % 5;

  await workTickets(database, owner, order.id, after, offset, 5);

  if (coursed) {
    // Starters are cleared: the server fires the mains.
    setClock(after(24));
    await fireCourse(database, owner, order.id, 2);
    await workTickets(database, owner, order.id, after, offset, 26);
  }

  if (check.compOne) {
    setClock(after(40));

    const [item] = await database
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "SUBMITTED")))
      .orderBy(asc(orderItems.createdAt))
      .limit(1);

    if (item) {
      await applyItemDiscount(database, owner, order.id, item.id, { discountDefinitionId: context.compId, reason: "Long wait", expectedVersion: await orderVersion(database, order.id) });
    }
  }

  if (check.taxExempt) {
    setClock(after(45));
    await setTaxExemption(database, owner, order.id, { reason: "School fundraiser (exempt organization)", reference: "MI-EXEMPT-4471", expectedVersion: await orderVersion(database, order.id) });
  }

  setClock(after(check.kind === "DINE_IN" ? (coursed ? 70 : 55) : check.kind === "BAR" ? 45 : 18));

  const opened = await openSettlement(database, owner, order.id);
  const amount = opened.orderAmountSnapshot;

  if (compareDecimals(amount, "0") > 0) {
    const tip = check.kind === "TAKEOUT" ? "0.00" : roundHalfUp(multiplyExact(amount, String(check.tipPercent / 100)), 2);
    const cash = check.tender === "CASH";
    const received = cash ? `${Number(wholeQuotientCeiling(addDecimals(amount, tip), "5")) * 5}.00` : null;

    await recordTender(database, owner, opened.settlementId, {
      idempotencyKey: `demo-pizza-tender-${order.id}`,
      tenderType: cash ? "CASH" : "EXTERNAL_CARD",
      cashDrawerSessionId: cash ? context.drawerSessionId : null,
      outcome: "RECORDED",
      amount,
      tipAmount: compareDecimals(tip, "0") > 0 ? tip : null,
      receivedAmount: received,
      externalReference: null,
      providerName: null,
      cardBrand: cash ? null : pickFrom(seededRandom(order.id), ["VISA", "MASTERCARD", "AMEX", "DISCOVER"]),
      cardLastFour: null,
      authorizationReference: null,
      otherDescription: null,
      failureReason: null,
      expectedVersion: opened.settlementVersion,
    });
  }

  const [settled] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, opened.settlementId));

  await completeSettlement(database, owner, opened.settlementId, { expectedVersion: settled!.version, idempotencyKey: `demo-pizza-close-${order.id}` });

  if (sessionId && tableId) {
    setClock(after(check.kind === "DINE_IN" ? (coursed ? 78 : 62) : 50));

    const [session] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, sessionId));

    await completeTableSession(database, owner, sessionId, { expectedVersion: session!.version });
    setClock(after(check.kind === "DINE_IN" ? (coursed ? 82 : 66) : 54));

    const [table] = await database.select({ version: restaurantTables.version, condition: restaurantTables.condition }).from(restaurantTables).where(eq(restaurantTables.id, tableId));

    if (table?.condition === "DIRTY") {
      await cleanTable(database, owner, tableId, { expectedVersion: table.version });
    }
  }
}

/**
 * Punches for every published past shift (a few minutes either side), one overtime week for the
 * busiest person in the third week, and the last shift that ended yesterday left without a
 * clock-out. Bartenders declare their cash tips for the last two weeks.
 */
async function punchShifts(
  database: Database,
  owner: Actor,
  input: { first: string; yesterday: string; today: string; done: Set<string>; record: (key: string) => Promise<void> },
): Promise<{ punches: number; declarations: number }> {
  const rows = await database
    .select({
      assignmentId: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
      positionId: shifts.positionId,
      positionCode: positions.code,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .innerJoin(employees, eq(employees.id, shiftAssignments.employeeId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
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
  const overtimeWeek = addDays(input.first, 14);
  const weekRows = rows.filter((row) => row.shiftDate >= overtimeWeek && row.shiftDate <= addDays(overtimeWeek, 6));
  const hours = new Map<string, number>();

  for (const row of weekRows) {
    hours.set(row.employeeId, (hours.get(row.employeeId) ?? 0) + (row.endAt.getTime() - row.startAt.getTime()) / 3_600_000);
  }

  const [overtimeEmployee, scheduledHours] = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
  const overtimeShifts = weekRows.filter((row) => row.employeeId === overtimeEmployee).length;
  const extraMinutes = overtimeShifts === 0 ? 0 : Math.min(240, Math.max(0, Math.ceil(((42 - scheduledHours) * 60) / overtimeShifts)));
  const missed = [...rows].reverse().find((row) => row.shiftDate === input.yesterday)?.assignmentId;
  const declareFrom = addDays(input.today, -14);
  const result = { punches: 0, declarations: 0 };

  for (const row of rows) {
    const key = `${KEY}.punch.${row.assignmentId}`;

    if (input.done.has(key)) {
      continue;
    }

    const random = seededRandom(row.assignmentId);
    const inAt = new Date(row.startAt.getTime() + between(random, -6, 9) * 60_000);
    let outAt = new Date(row.endAt.getTime() + between(random, -10, 15) * 60_000);

    if (row.employeeId === overtimeEmployee && row.shiftDate >= overtimeWeek && row.shiftDate <= addDays(overtimeWeek, 6) && extraMinutes > 0) {
      outAt = new Date(row.endAt.getTime() + extraMinutes * 60_000);
    }

    setClock(inAt);

    const code = await codeOf(
      (async () => {
        const entry = await clockIn(database, owner, { employeeId: row.employeeId, positionId: row.positionId, idempotencyKey: `demo-pizza-in-${row.assignmentId}` });

        if (row.assignmentId !== missed) {
          const [open] = await database.select({ version: timeEntries.version }).from(timeEntries).where(eq(timeEntries.id, entry.entryId));

          setClock(outAt);
          await clockOut(database, owner, { entryId: entry.entryId, expectedVersion: open!.version, idempotencyKey: `demo-pizza-out-${row.assignmentId}` });
        }
      })(),
    );

    if (code === null) {
      result.punches += 1;
    }

    if (row.positionCode === "BARTENDER" && row.shiftDate >= declareFrom && row.assignmentId !== missed) {
      setClock(new Date(outAt.getTime() + 5 * 60_000));

      const declared = await codeOf(
        declareTips(database, owner, { employeeId: row.employeeId, businessDate: row.shiftDate, amount: `${between(random, 8, 45)}.00`, note: "Cash tips from the bar" }),
      );

      if (declared === null) {
        result.declarations += 1;
      }
    }

    await input.record(key);
  }

  return result;
}
