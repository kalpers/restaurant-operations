import { randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  inventoryBalances,
  locations,
  orders,
  positions,
  restaurantAreas,
  schedulePeriods,
  unitsOfMeasure,
  users,
} from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createEmployee } from "../../src/modules/employees/services/employee-service";
import { createItem as createInventoryItem, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { postInventoryTransaction } from "../../src/modules/inventory/services/posting-service";
import {
  createCategory,
  createItem,
  createMenu,
  createPlacement,
  setMenuLocation,
} from "../../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../../src/modules/menu/services/modifier-effect-service";
import {
  attachGroup,
  createGroup,
  createModifier,
  setGroupModifier,
} from "../../src/modules/menu/services/modifier-service";
import { createStation, setItemRouting } from "../../src/modules/menu/services/prep-station-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addIngredient } from "../../src/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, publishRevision } from "../../src/modules/recipes/services/recipe-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { addRecurringAvailability } from "../../src/modules/scheduling/services/availability-service";
import {
  archivePeriod,
  assignEmployee,
  createPeriod,
  createShift,
} from "../../src/modules/scheduling/services/schedule-service";
import { withTransaction } from "../../src/db/transactions/transaction-context";

import { createRoleAccount, type E2eScope, type OrdersAccount } from "./e2e-orders";

loadLocalEnv();
pointAtTestDatabase();

// The Phase 13 restaurant-day spec's own data. Accounts use their own email domain and
// tables their own prefix, so no other spec's cleanup can touch them on a parallel worker.
export const DAY_SCOPE: E2eScope = {
  emailDomain: "day-e2e.example.test",
  rolePrefix: "DAY_E2E_",
  tablePrefix: "DAY-",
};

/** A week no other spec schedules, so publishing it never overlaps another period. */
export const DAY_WEEK = { monday: "2031-06-02", sunday: "2031-06-08" };

const LONG_AGO = new Date("2024-01-01T00:00:00Z");
const code = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

export const dayAccount = (roleCode: string) => createRoleAccount(roleCode, DAY_SCOPE);

async function mainLocationId(): Promise<string> {
  const [location] = await getDatabase().select({ id: locations.id }).from(locations).where(eq(locations.locationCode, "MAIN"));

  return location!.id;
}

async function actorOf(account: OrdersAccount): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId: await mainLocationId() });
}

async function unit(unitCode: string): Promise<string> {
  const [row] = await getDatabase().select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, unitCode));

  return row!.id;
}

/**
 * The canonical Bacon Cheeseburger (15.99) with Medium / No Onion / Extra Pickles (+0.50) /
 * Swiss instead of American (+1.00), routed to a grill; fries (4.50) to the same kitchen;
 * a margarita (11.00) to a bar. Recipe: bun, American, onion, 3 pickles. Every ingredient
 * starts with 50 on hand. Built through the services, as an owner would configure it.
 */
export async function createDayMenu(owner: OrdersAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const each = await unit("EACH");
  const suffix = randomUUID().slice(0, 6);
  const stock = async (name: string) => {
    const item = await createInventoryItem(database, actor, {
      code: code("DAYI"),
      name: `${name} ${suffix}`,
      description: null,
      measurementType: "COUNT",
      baseUnitId: each,
    });

    await setItemLocation(database, actor, item.id, {
      parLevel: null,
      reorderLevel: null,
      reorderTarget: null,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });
    // Opening stock, posted through the Inventory domain's ledger API.
    await withTransaction(database, (transaction) =>
      postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: "50",
        unitOfMeasureId: each,
        incomingTotalCost: "25.00",
        createdByUserId: actor.userId,
      }),
    );

    return item;
  };
  const bun = await stock("Day bun");
  const american = await stock("Day American");
  const swiss = await stock("Day Swiss");
  const onion = await stock("Day onion");
  const pickles = await stock("Day pickle");
  const menu = await createMenu(database, actor, { code: code("DAYM"), name: `Day menu ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId: actor.locationId, active: true });

  const category = await createCategory(database, actor, {
    code: code("DAYC"),
    name: `Day ${suffix}`,
    description: null,
    displayOrder: 0,
  });
  const sell = async (name: string, price: string, itemType: "FOOD" | "BEVERAGE" = "FOOD") => {
    const item = await createItem(database, actor, {
      code: code("DAY"),
      name: `${name} ${suffix}`,
      shortName: null,
      description: null,
      itemType,
      displayOrder: 0,
    });

    await changePrice(database, actor, item.id, { locationId: null, price, effectiveFrom: null }, LONG_AGO);
    await createPlacement(database, actor, { menuId: menu.id, menuCategoryId: category.id, menuItemId: item.id, displayOrder: 0 });

    return item;
  };
  const burger = await sell("Bacon Cheeseburger", "15.99");
  const fries = await sell("Fries", "4.50");
  const margarita = await sell("Margarita", "11.00", "BEVERAGE");
  const grill = await createStation(database, actor, { code: code("DGR"), name: `Grill ${suffix}`, stationType: "KITCHEN", sortOrder: 0 });
  const bar = await createStation(database, actor, { code: code("DBR"), name: `Bar ${suffix}`, stationType: "BAR", sortOrder: 1 });

  await setItemRouting(database, actor, burger.id, { prepStationIds: [grill.id] });
  await setItemRouting(database, actor, fries.id, { prepStationIds: [grill.id] });
  await setItemRouting(database, actor, margarita.id, { prepStationIds: [bar.id] });

  const modifier = (name: string, priceAdjustment: string, type: "INSTRUCTION" | "REMOVE_COMPONENT" | "ADJUST_COMPONENT", instruction: string) =>
    createModifier(database, actor, {
      code: code("DAYMOD"),
      name,
      description: null,
      priceAdjustment,
      preparationEffectType: type,
      preparationInstruction: instruction,
    });
  const medium = await modifier("Medium", "0.00", "INSTRUCTION", "Cook medium");
  const noOnion = await modifier("No Onion", "0.00", "REMOVE_COMPONENT", "No onion");
  const extraPickles = await modifier("Extra Pickles", "0.50", "ADJUST_COMPONENT", "Extra pickles");
  const swissInstead = await modifier("Swiss instead of American", "1.00", "INSTRUCTION", "Swiss, not American");
  const group = async (name: string, selectionType: "REQUIRED_SINGLE" | "OPTIONAL_MULTIPLE", modifierIds: string[], displayOrder: number) => {
    const created = await createGroup(database, actor, {
      code: code("DAYG"),
      name,
      description: null,
      selectionType,
      minimumSelections: selectionType === "REQUIRED_SINGLE" ? 1 : 0,
      maximumSelections: selectionType === "REQUIRED_SINGLE" ? 1 : 3,
      displayOrder: 0,
    });

    for (const [index, modifierId] of modifierIds.entries()) {
      await setGroupModifier(database, actor, created.id, { modifierId, displayOrder: index, active: true });
    }

    await attachGroup(database, actor, burger.id, {
      modifierGroupId: created.id,
      displayOrder,
      requiredOverride: null,
      minimumOverride: null,
      maximumOverride: null,
    });
  };

  await group("Temperature", "REQUIRED_SINGLE", [medium.id], 0);
  await group("Toppings", "OPTIONAL_MULTIPLE", [noOnion.id, extraPickles.id, swissInstead.id], 1);

  const recipe = await createRecipe(database, actor, { code: code("DAYR"), name: burger.name, description: null, menuItemId: burger.id });
  const draft = await createDraftRevision(database, actor, recipe.id, { yieldQuantity: "1", yieldUnitId: each, preparationNotes: null });
  let version = draft.version;

  for (const [inventoryItemId, quantity] of [
    [bun.id, "1"],
    [american.id, "1"],
    [onion.id, "1"],
    [pickles.id, "3"],
  ] as const) {
    version = (
      await addIngredient(database, actor, recipe.id, draft.id, {
        inventoryItemId,
        quantity,
        unitOfMeasureId: each,
        preparationNote: null,
        sortOrder: 0,
        expectedVersion: version,
      })
    ).revisionVersion;
  }

  await publishRevision(database, actor, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version }, LONG_AGO);

  const effect = (modifierId: string, inventoryItemId: string, effectType: "ADD" | "REMOVE" | "ADJUST", quantity: string | null) =>
    addModifierEffect(database, actor, modifierId, {
      menuItemId: burger.id,
      inventoryItemId,
      effectType,
      quantity,
      unitOfMeasureId: quantity === null ? null : each,
    });

  await effect(noOnion.id, onion.id, "REMOVE", null);
  await effect(extraPickles.id, pickles.id, "ADJUST", "2");
  await effect(swissInstead.id, american.id, "REMOVE", null);
  await effect(swissInstead.id, swiss.id, "ADD", "1");

  return {
    categoryName: category.name,
    burger,
    fries,
    margarita,
    stock: { bun, american, swiss, onion, pickles },
  };
}

/** A clean four-top in the MAIN dining room. */
export async function createDayTable(owner: OrdersAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const [dining] = await database
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(and(eq(restaurantAreas.locationId, actor.locationId), eq(restaurantAreas.areaType, "DINING")));
  const tableNumber = `${DAY_SCOPE.tablePrefix}${randomUUID().slice(0, 6)}`;
  const { id } = await createTable(database, actor, {
    restaurantAreaId: dining!.id,
    tableNumber,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });

  return { id, tableNumber };
}

/**
 * A draft week with one server shift, filled, ready for a manager to publish on screen.
 * The owner hires the staff member (managers can't create employees) and drafts the week.
 */
export async function createDraftSchedule(owner: OrdersAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const [server] = await database.select({ id: positions.id }).from(positions).where(eq(positions.code, "SERVER"));
  const employee = await createEmployee(database, actor, {
    employeeNumber: `DAY-${randomUUID()}`.slice(0, 40),
    firstName: "Dana",
    middleName: null,
    lastName: `Day-${randomUUID().slice(0, 6)}`,
    preferredName: null,
    workEmail: null,
    hireDate: "2024-01-15",
    employmentType: "PART_TIME",
    positionId: server!.id,
  });

  for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
    await addRecurringAvailability(
      database,
      actor,
      { kind: "employee", employeeId: employee.id },
      {
        dayOfWeek,
        startTime: "00:00",
        endTime: "00:00",
        availabilityType: "AVAILABLE",
        effectiveFrom: "2024-01-15",
        effectiveTo: null,
        thisLocationOnly: false,
      },
    );
  }

  // A retry runs against the same database, where an earlier attempt may already have
  // published this week. Two published periods can't share a date, so archive that one
  // first (archiving keeps it as history) or the on-screen Publish would be refused.
  const earlier = await database
    .select({ id: schedulePeriods.id, version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(
      and(
        like(schedulePeriods.name, `${DAY_SCOPE.rolePrefix}%`),
        eq(schedulePeriods.status, "PUBLISHED"),
        eq(schedulePeriods.startDate, DAY_WEEK.monday),
      ),
    );

  for (const row of earlier) {
    await archivePeriod(database, actor, row.id, { expectedVersion: row.version });
  }

  const period = await createPeriod(database, actor, {
    name: `${DAY_SCOPE.rolePrefix}${randomUUID().slice(0, 8)}`,
    startDate: DAY_WEEK.monday,
    endDate: DAY_WEEK.sunday,
  });
  const versionOf = async () =>
    (await database.select({ version: schedulePeriods.version }).from(schedulePeriods).where(eq(schedulePeriods.id, period.id)))[0]!
      .version;
  const shift = await createShift(database, actor, period.id, {
    positionId: server!.id,
    restaurantAreaId: null,
    shiftDate: DAY_WEEK.monday,
    startTime: "16:00",
    endTime: "23:00",
    requiredEmployeeCount: 1,
    courseOrStationNote: null,
    notes: null,
    priority: 0,
    expectedPeriodVersion: await versionOf(),
  });

  await assignEmployee(database, actor, shift.id, { employeeId: employee.id, notes: null, expectedPeriodVersion: await versionOf() });

  return { periodId: period.id };
}

export async function orderNumberOf(orderId: string): Promise<number> {
  const [row] = await getDatabase().select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));

  return row!.orderNumber;
}

export async function onHand(inventoryItemId: string): Promise<string> {
  const [row] = await getDatabase()
    .select({ quantity: inventoryBalances.quantityOnHand })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.inventoryItemId, inventoryItemId));

  return row?.quantity ?? "0.0000";
}

export async function periodStatus(periodId: string): Promise<string> {
  const [row] = await getDatabase().select({ status: schedulePeriods.status }).from(schedulePeriods).where(eq(schedulePeriods.id, periodId));

  return row!.status;
}

/**
 * The day's records are operational history (append-only ledgers, audit), kept in the
 * disposable test database. The accounts are disabled, which needs no table lock, so a
 * parallel worker is never stalled by this cleanup.
 */
export async function disableDayAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${DAY_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
