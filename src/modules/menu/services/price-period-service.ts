import { and, asc, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@/db";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { locations, menuItems, pricePeriodItems, pricePeriods } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { isPositiveDecimal, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { periodsOverlap, type PricePeriodRule } from "../rules/price-periods";
import { assertPermission } from "./access";

// Phase 28 price periods ("happy hour"), policies 2 to 5. Managers with `menu.pricing.edit`
// set them up per location; `menu.pricing.view` lists them. Each change is one transaction
// with its audit row, taken under the location row lock so two editors can't both save
// overlapping periods. Periods are deactivated, never deleted (migration 0066).

export type PricePeriodInput = {
  name: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  orderTypes: string[] | null;
  firstDate: string | null;
  lastDate: string | null;
  items: { menuItemId: string; price: string }[];
};

export type PricePeriodView = {
  id: string;
  name: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  orderTypes: string[] | null;
  firstDate: string | null;
  lastDate: string | null;
  active: boolean;
  version: number;
  items: { menuItemId: string; code: string; name: string; price: string }[];
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ORDER_TYPES = new Set(["DINE_IN", "BAR", "TAKEOUT"]);
const MAX_ITEMS = 200;

function normalizePrice(value: string): string {
  let price: string;

  try {
    price = toScale(value, 2);
  } catch {
    throw new BusinessRuleError("INVALID_PRICE", "A price is a number with at most two decimal places.");
  }

  if (price.startsWith("-") || (!isPositiveDecimal(price) && price !== "0.00")) {
    throw new BusinessRuleError("INVALID_PRICE", "A price can't be negative.");
  }

  return price;
}

/** Business checks on the shape Zod already validated. */
function normalize(input: PricePeriodInput): PricePeriodInput {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 60) {
    throw new BusinessRuleError("INVALID_NAME", "Give the period a name of 1 to 60 characters.");
  }

  const days = [...new Set(input.daysOfWeek)].sort();

  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new BusinessRuleError("INVALID_DAYS", "Choose at least one day of the week.");
  }

  if (!TIME.test(input.startTime) || !TIME.test(input.endTime)) {
    throw new BusinessRuleError("INVALID_TIME", "Times are HH:MM, 00:00 to 23:59.");
  }

  if (input.startTime === input.endTime) {
    throw new BusinessRuleError("INVALID_TIME", "The period must start and end at different times.");
  }

  const orderTypes =
    input.orderTypes === null || input.orderTypes.length === 0 ? null : [...new Set(input.orderTypes)].sort();

  if (orderTypes && orderTypes.some((type) => !ORDER_TYPES.has(type))) {
    throw new BusinessRuleError("INVALID_ORDER_TYPE", "Order types are dine-in, bar and takeout.");
  }

  if (input.firstDate && input.lastDate && input.lastDate < input.firstDate) {
    throw new BusinessRuleError("INVALID_DATES", "The last date can't be before the first.");
  }

  if (input.items.length === 0 || input.items.length > MAX_ITEMS) {
    throw new BusinessRuleError("INVALID_ITEMS", `Price 1 to ${MAX_ITEMS} items in the period.`);
  }

  const seen = new Set<string>();
  const items = input.items.map((item) => {
    if (seen.has(item.menuItemId)) {
      throw new BusinessRuleError("DUPLICATE_ITEM", "Each item can appear once in a period.");
    }

    seen.add(item.menuItemId);

    return { menuItemId: item.menuItemId, price: normalizePrice(item.price) };
  });

  return {
    name,
    daysOfWeek: days,
    startTime: input.startTime,
    endTime: input.endTime,
    orderTypes,
    firstDate: input.firstDate || null,
    lastDate: input.lastDate || null,
    items,
  };
}

async function lockActorLocation(transaction: DatabaseTransaction, actor: Actor) {
  const [row] = await transaction
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, actor.locationId), eq(locations.organizationId, actor.organizationId)))
    .for("update");

  if (!row) {
    throw new NotFoundError("location");
  }
}

async function requireItems(executor: DatabaseExecutor, actor: Actor, menuItemIds: readonly string[]) {
  const rows = await executor
    .select({ id: menuItems.id, active: menuItems.active })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, actor.organizationId), inArray(menuItems.id, [...menuItemIds])));

  if (rows.length !== new Set(menuItemIds).size) {
    throw new NotFoundError("menu item");
  }

  if (rows.some((row) => !row.active)) {
    throw new BusinessRuleError("ITEM_INACTIVE", "Only items on the menu can be priced in a period.");
  }
}

/**
 * Policy 3: an active period may not price an item another active period prices for a shared
 * order type at a shared time. Checked under the location lock, so it can't be raced.
 */
async function assertNoOverlap(
  executor: DatabaseExecutor,
  actor: Actor,
  candidate: PricePeriodRule,
  menuItemIds: readonly string[],
) {
  const others = await executor
    .select({ period: pricePeriods, menuItemId: pricePeriodItems.menuItemId, itemName: menuItems.name })
    .from(pricePeriodItems)
    .innerJoin(pricePeriods, eq(pricePeriods.id, pricePeriodItems.pricePeriodId))
    .innerJoin(menuItems, eq(menuItems.id, pricePeriodItems.menuItemId))
    .where(
      and(
        eq(pricePeriods.organizationId, actor.organizationId),
        eq(pricePeriods.locationId, actor.locationId),
        eq(pricePeriods.active, true),
        candidate.id === "" ? undefined : ne(pricePeriods.id, candidate.id),
        inArray(pricePeriodItems.menuItemId, [...menuItemIds]),
      ),
    );

  for (const { period, itemName } of others) {
    const rule: PricePeriodRule = { ...period, firstDate: period.firstDate, lastDate: period.lastDate };

    if (periodsOverlap(candidate, rule)) {
      throw new BusinessRuleError(
        "PRICE_PERIOD_OVERLAP",
        `${itemName} is already priced by "${period.name}" at some of those times.`,
      );
    }
  }
}

function auditDetails(input: PricePeriodInput) {
  return {
    name: input.name,
    daysOfWeek: input.daysOfWeek,
    startTime: input.startTime,
    endTime: input.endTime,
    orderTypes: input.orderTypes,
    firstDate: input.firstDate,
    lastDate: input.lastDate,
    itemCount: input.items.length,
  };
}

async function writeItems(transaction: DatabaseTransaction, actor: Actor, periodId: string, input: PricePeriodInput) {
  await transaction.delete(pricePeriodItems).where(eq(pricePeriodItems.pricePeriodId, periodId));
  await transaction.insert(pricePeriodItems).values(
    input.items.map((item) => ({
      organizationId: actor.organizationId,
      pricePeriodId: periodId,
      menuItemId: item.menuItemId,
      price: item.price,
    })),
  );
}

function asRule(id: string, input: PricePeriodInput): PricePeriodRule {
  return { id, ...input, active: true };
}

export async function createPricePeriod(database: Database, actor: Actor, raw: PricePeriodInput) {
  assertPermission(actor, "menu.pricing.edit");

  const input = normalize(raw);

  return withTransaction(database, async (transaction) => {
    await lockActorLocation(transaction, actor);
    await requireItems(transaction, actor, input.items.map((item) => item.menuItemId));
    await assertNoOverlap(transaction, actor, asRule("", input), input.items.map((item) => item.menuItemId));

    const [row] = await transaction
      .insert(pricePeriods)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        name: input.name,
        daysOfWeek: input.daysOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        orderTypes: input.orderTypes,
        firstDate: input.firstDate,
        lastDate: input.lastDate,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning();

    await writeItems(transaction, actor, row!.id, input);
    await recordAudit(transaction, actor, {
      action: "menu.price-period-created",
      entityId: row!.id,
      details: auditDetails(input),
    });

    return { id: row!.id, version: row!.version };
  });
}

async function requirePeriod(executor: DatabaseExecutor, actor: Actor, periodId: string) {
  const [row] = await executor
    .select()
    .from(pricePeriods)
    .where(
      and(
        eq(pricePeriods.id, periodId),
        eq(pricePeriods.organizationId, actor.organizationId),
        eq(pricePeriods.locationId, actor.locationId),
      ),
    );

  if (!row) {
    throw new NotFoundError("price period");
  }

  return row;
}

export async function updatePricePeriod(
  database: Database,
  actor: Actor,
  periodId: string,
  raw: PricePeriodInput & { expectedVersion: number },
) {
  assertPermission(actor, "menu.pricing.edit");

  const input = normalize(raw);

  return withTransaction(database, async (transaction) => {
    await lockActorLocation(transaction, actor);

    const existing = await requirePeriod(transaction, actor, periodId);

    if (!existing.active) {
      throw new BusinessRuleError("PRICE_PERIOD_INACTIVE", "That period has been deactivated.");
    }

    await requireItems(transaction, actor, input.items.map((item) => item.menuItemId));
    await assertNoOverlap(transaction, actor, asRule(periodId, input), input.items.map((item) => item.menuItemId));

    const updated = await updateVersioned(transaction, pricePeriods, {
      id: periodId,
      organizationId: actor.organizationId,
      expectedVersion: raw.expectedVersion,
      label: "price period",
      values: {
        name: input.name,
        daysOfWeek: input.daysOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        orderTypes: input.orderTypes,
        firstDate: input.firstDate,
        lastDate: input.lastDate,
        updatedByUserId: actor.userId,
      },
    });

    await writeItems(transaction, actor, periodId, input);
    await recordAudit(transaction, actor, {
      action: "menu.price-period-updated",
      entityId: periodId,
      details: auditDetails(input),
    });

    return { id: periodId, version: updated.version };
  });
}

export async function deactivatePricePeriod(
  database: Database,
  actor: Actor,
  periodId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "menu.pricing.edit");

  return withTransaction(database, async (transaction) => {
    const existing = await requirePeriod(transaction, actor, periodId);
    const updated = await updateVersioned(transaction, pricePeriods, {
      id: periodId,
      organizationId: actor.organizationId,
      expectedVersion: input.expectedVersion,
      label: "price period",
      values: { active: false, updatedByUserId: actor.userId },
    });

    await recordAudit(transaction, actor, {
      action: "menu.price-period-deactivated",
      entityId: periodId,
      details: { name: existing.name },
    });

    return { id: periodId, version: updated.version };
  });
}

/** The location's periods, active first, with the items they price. */
export async function listPricePeriods(executor: DatabaseExecutor, actor: Actor): Promise<PricePeriodView[]> {
  assertPermission(actor, "menu.pricing.view");

  const periods = await executor
    .select()
    .from(pricePeriods)
    .where(and(eq(pricePeriods.organizationId, actor.organizationId), eq(pricePeriods.locationId, actor.locationId)))
    .orderBy(asc(pricePeriods.name), asc(pricePeriods.id));

  if (periods.length === 0) {
    return [];
  }

  const items = await executor
    .select({
      pricePeriodId: pricePeriodItems.pricePeriodId,
      menuItemId: pricePeriodItems.menuItemId,
      code: menuItems.code,
      name: menuItems.name,
      price: pricePeriodItems.price,
    })
    .from(pricePeriodItems)
    .innerJoin(menuItems, eq(menuItems.id, pricePeriodItems.menuItemId))
    .where(inArray(pricePeriodItems.pricePeriodId, periods.map((period) => period.id)))
    .orderBy(asc(menuItems.name));

  return periods
    .map((period) => ({
      id: period.id,
      name: period.name,
      daysOfWeek: period.daysOfWeek,
      startTime: period.startTime.slice(0, 5),
      endTime: period.endTime.slice(0, 5),
      orderTypes: period.orderTypes,
      firstDate: period.firstDate,
      lastDate: period.lastDate,
      active: period.active,
      version: period.version,
      items: items
        .filter((item) => item.pricePeriodId === period.id)
        .map(({ menuItemId, code, name, price }) => ({ menuItemId, code, name, price })),
    }))
    .sort((left, right) => Number(right.active) - Number(left.active));
}
