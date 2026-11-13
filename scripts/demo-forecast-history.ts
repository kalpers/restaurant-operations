import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { orderItems, orders, positions, settlements, tableSessions } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import {
  createItem as createMenuItem,
  createPlacement,
  listCategories,
  listItems as listMenuItems,
  listMenus,
  updateItem as updateMenuItem,
} from "../src/modules/menu/services/catalog-service";
import { changePrice } from "../src/modules/menu/services/pricing-service";
import {
  changeTaxRate,
  createTaxCategory,
  listTaxCategories,
  listTaxRates,
} from "../src/modules/menu/services/tax-service";
import { addDraftItem } from "../src/modules/orders/services/draft-item-service";
import { createOrder } from "../src/modules/orders/services/order-service";
import { cleanTable, listTablesForConfiguration } from "../src/modules/restaurant/services/table-service";
import { createRatio, getForecastSettings } from "../src/modules/scheduling/services/forecast-service";
import type { DemandMeasure } from "../src/modules/scheduling/rules/demand-forecast";
import { openSettlement, recordTender } from "../src/modules/settlements/services/settlement-service";
import { businessDateOf } from "../src/shared/time/business-date-service";
import { addDays, dayOfWeek, localToInstant } from "../src/shared/time/zoned-time";
import { completeSettlement } from "../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../src/workflows/end-table-session/end-table-session";
import { seatParty } from "../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../src/workflows/submit-order/submit-order";

// Phase 24 (D11, amendment 2): six weeks of fake closed checks at MAIN so the demand forecast
// has something to work from, plus staffing ratios for Server, Bartender, Host and Cook.
// Every check goes through the real seating, order, SEND and settlement services with the
// clock moved back to the check's time, so its business date, tenders and sessions all agree
// and nothing frozen is rewritten. The checks sell one unrouted "Demo history plate" with no
// recipe, so they make no kitchen tickets and move no stock. Paid as external card, so no
// cash drawer is needed. Idempotent: a business date that already has a history check is
// skipped, so a rerun adds only the dates an interrupted run didn't reach.

const HISTORY_ITEM = "DEMO_FORECAST_PLATE";
const HISTORY_TAX = "DEMO_HISTORY";
const HISTORY_DAYS = 42;
const TIME_ZONE_FALLBACK = "America/Detroit";

/** Busier toward the weekend, like most restaurants. Index is day of week (0 = Sunday). */
const DAY_FACTOR = [0.9, 0.6, 0.7, 0.8, 1.0, 1.3, 1.4] as const;
const PARTY_SIZES = [2, 4, 3, 2, 6, 4, 2, 3] as const;

const DEMO_RATIOS: readonly {
  positionCode: string;
  measure: DemandMeasure;
  unitsPerEmployeeHour: string;
  minimumEmployees: number;
  maximumEmployees: number;
}[] = [
  { positionCode: "SERVER", measure: "DINING_COVERS", unitsPerEmployeeHour: "12", minimumEmployees: 1, maximumEmployees: 6 },
  { positionCode: "BARTENDER", measure: "BAR_CHECKS", unitsPerEmployeeHour: "8", minimumEmployees: 1, maximumEmployees: 3 },
  { positionCode: "HOST", measure: "DINING_COVERS", unitsPerEmployeeHour: "30", minimumEmployees: 1, maximumEmployees: 2 },
  { positionCode: "COOK", measure: "ALL_CHECKS", unitsPerEmployeeHour: "10", minimumEmployees: 1, maximumEmployees: 4 },
];

const RealDate = Date;
let offsetMs = 0;

/** Moves `new Date()` and `Date.now()` for this script only. Restored by `restoreClock`. */
function installShiftedClock(): void {
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(RealDate.now() + offsetMs);
      } else {
        super(...(args as [string | number | Date]));
      }
    }

    static now(): number {
      return RealDate.now() + offsetMs;
    }
  }

  globalThis.Date = ShiftedDate as DateConstructor;
}

function setClock(instant: Date): void {
  offsetMs = instant.getTime() - RealDate.now();
}

function restoreClock(): void {
  globalThis.Date = RealDate;
  offsetMs = 0;
}

type Check = { time: string; kind: "DINE_IN" | "BAR" | "TAKEOUT"; partySize: number };

/** A fixed plan per day of week, so reruns and other machines see the same history. */
function checksFor(date: string, dayIndex: number): Check[] {
  const factor = DAY_FACTOR[dayOfWeek(date)]!;
  const lunch = Math.round(2 * factor);
  const dinner = Math.round(5 * factor);
  const checks: Check[] = [];
  const size = (index: number) => PARTY_SIZES[(dayIndex + index) % PARTY_SIZES.length]!;

  for (let index = 0; index < lunch; index += 1) {
    checks.push({ time: `12:${String(10 + index * 15).padStart(2, "0")}`, kind: "DINE_IN", partySize: size(index) });
  }

  for (let index = 0; index < dinner; index += 1) {
    const minutes = 18 * 60 + index * 25;

    checks.push({
      time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
      kind: "DINE_IN",
      partySize: size(index + lunch),
    });
  }

  checks.push({ time: "17:40", kind: "TAKEOUT", partySize: 1 });
  checks.push({ time: "19:05", kind: "BAR", partySize: 2 });

  if (factor >= 1) {
    checks.push({ time: "20:35", kind: "BAR", partySize: 2 });
    checks.push({ time: "12:45", kind: "TAKEOUT", partySize: 1 });
  }

  return checks.sort((a, b) => a.time.localeCompare(b.time));
}

async function seatAndSell(
  database: Database,
  owner: Actor,
  input: { check: Check; itemId: string; tables: { id: string; capacity: number; areaType: string }[] },
): Promise<boolean> {
  const { check } = input;
  let sessionId: string | null = null;
  let tableId: string | null = null;

  if (check.kind !== "TAKEOUT") {
    const wanted = check.kind === "BAR" ? "BAR" : "DINING";
    const candidates = input.tables.filter((table) => table.areaType === wanted && table.capacity >= check.partySize);

    for (const table of candidates) {
      try {
        const seated = await seatParty(database, owner, {
          tableIds: [table.id],
          partySize: check.partySize,
          serverEmployeeId: null,
        });

        sessionId = seated.id;
        tableId = table.id;
        break;
      } catch {
        // Occupied or not clean: try the next table.
      }
    }

    if (!sessionId) {
      return false;
    }
  }

  const order = sessionId
    ? await createOrder(database, owner, { orderType: check.kind as "DINE_IN" | "BAR", tableSessionId: sessionId })
    : await createOrder(database, owner, { orderType: "TAKEOUT" });
  const drafted = await addDraftItem(database, owner, order.id, {
    expectedVersion: order.version,
    menuItemId: input.itemId,
    quantity: check.partySize,
    selections: [],
    specialInstructions: null,
  });

  await sendOrderItems(database, owner, order.id, {
    expectedVersion: drafted.orderVersion,
    idempotencyKey: `demo-history-${order.id}`,
  });

  const [row] = await database.select({ totalDue: orders.totalDue }).from(orders).where(eq(orders.id, order.id));
  const { settlementId } = await openSettlement(database, owner, order.id);
  const [opened] = await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, settlementId));

  await recordTender(database, owner, settlementId, {
    idempotencyKey: `demo-history-tender-${order.id}`,
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
    idempotencyKey: `demo-history-close-${order.id}`,
  });

  if (sessionId && tableId) {
    const [session] = await database
      .select({ version: tableSessions.version })
      .from(tableSessions)
      .where(eq(tableSessions.id, sessionId));

    await completeTableSession(database, owner, sessionId, { expectedVersion: session!.version });

    const table = (await listTablesForConfiguration(database, owner)).find((entry) => entry.id === tableId);

    if (table?.condition === "DIRTY") {
      await cleanTable(database, owner, tableId, { expectedVersion: table.version });
    }
  }

  return true;
}

/**
 * Where the location charges tax, SEND needs the plate's category to have a rate in effect
 * at each check's time, so the category and its rate are made while the clock is moved back.
 */
async function historyTaxCategory(database: Database, owner: Actor): Promise<string> {
  let category = (await listTaxCategories(database, owner)).find((row) => row.code === HISTORY_TAX);

  if (!category) {
    category = await createTaxCategory(database, owner, {
      code: HISTORY_TAX,
      name: "Demo history (6%)",
      description: "Tax for the demand forecast demo's fake sales.",
    });
  }

  const rated = (await listTaxRates(database, owner)).some((rate) => rate.taxCategoryId === category!.id);

  if (!rated) {
    await changeTaxRate(database, owner, {
      taxCategoryId: category.id,
      ratePercent: "6",
      effectiveFrom: null,
      expectedCurrentRateId: null,
    });
  }

  return category.id;
}

async function seedRatios(database: Database, owner: Actor): Promise<number> {
  const settings = await getForecastSettings(database, owner);
  const withRatio = new Set(settings.ratios.filter((ratio) => ratio.active).map((ratio) => ratio.positionId));
  let added = 0;

  for (const demo of DEMO_RATIOS) {
    const [position] = await database
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.organizationId, owner.organizationId), eq(positions.code, demo.positionCode)));

    if (!position || withRatio.has(position.id)) {
      continue;
    }

    await createRatio(database, owner, {
      positionId: position.id,
      measure: demo.measure,
      unitsPerEmployeeHour: demo.unitsPerEmployeeHour,
      minimumEmployees: demo.minimumEmployees,
      maximumEmployees: demo.maximumEmployees,
    });
    added += 1;
  }

  return added;
}

export async function seedDemoForecastHistory(
  database: Database,
  owner: Actor,
  clock: { timeZone: string | null; businessDayCutoff: string },
): Promise<{ checks: number; skipped: number; ratios: number; datesAlreadyPresent: number }> {
  const ratios = await seedRatios(database, owner);
  const existingItem = (await listMenuItems(database, owner)).find((item) => item.code === HISTORY_ITEM);
  const doneDates = new Set(
    existingItem
      ? (
          await database
            .selectDistinct({ businessDate: orders.businessDate })
            .from(orders)
            .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
            .where(and(eq(orders.locationId, owner.locationId), eq(orderItems.menuItemId, existingItem.id)))
        ).map((row) => row.businessDate)
      : [],
  );

  const timeZone = clock.timeZone ?? TIME_ZONE_FALLBACK;
  const today = businessDateOf(new Date(), { timeZone, businessDayCutoff: clock.businessDayCutoff });
  const first = addDays(today, -HISTORY_DAYS);
  const [mainMenu] = (await listMenus(database, owner)).filter((menu) => menu.code === "MAIN");
  const [category] = await listCategories(database, owner);

  if (!mainMenu || !category) {
    throw new Error("The Main Menu or a menu category is missing. Run `npm run db:seed` first.");
  }

  const tables = (await listTablesForConfiguration(database, owner))
    .filter((table) => table.active && table.areaActive)
    .sort((a, b) => a.capacity - b.capacity || a.sortOrder - b.sortOrder);
  let checks = 0;
  let skipped = 0;

  installShiftedClock();

  try {
    let item = existingItem ? { id: existingItem.id } : null;

    // The plate, its price and its tax rate are made "before" the history, so all three are
    // in effect for all of it.
    setClock(localToInstant(addDays(first, -1), "10:00", timeZone)!);

    const taxCategoryId = await historyTaxCategory(database, owner);

    if (existingItem && existingItem.taxCategoryId !== taxCategoryId) {
      await updateMenuItem(database, owner, existingItem.id, {
        name: existingItem.name,
        shortName: existingItem.shortName,
        description: existingItem.description,
        itemType: existingItem.itemType as "FOOD",
        displayOrder: existingItem.displayOrder,
        taxCategoryId,
        active: existingItem.active,
        available: existingItem.available,
        expectedVersion: existingItem.version,
      });
    }

    if (!item) {
      item = await createMenuItem(database, owner, {
        code: HISTORY_ITEM,
        name: "Demo history plate",
        shortName: null,
        description: "Fake sales for the demand forecast demo. Not a real dish.",
        itemType: "FOOD",
        displayOrder: 9990,
        taxCategoryId,
      });

      await changePrice(database, owner, item.id, { locationId: null, price: "15.00", effectiveFrom: null });
      await createPlacement(database, owner, {
        menuId: mainMenu.id,
        menuCategoryId: category.id,
        menuItemId: item.id,
        displayOrder: 9990,
      });
    }

    for (let day = 0; day < HISTORY_DAYS; day += 1) {
      const date = addDays(first, day);

      if (doneDates.has(date)) {
        continue;
      }

      for (const check of checksFor(date, day)) {
        const instant = localToInstant(date, check.time, timeZone);

        if (!instant) {
          continue;
        }

        setClock(instant);

        if (await seatAndSell(database, owner, { check, itemId: item.id, tables })) {
          checks += 1;
        } else {
          skipped += 1;
        }
      }
    }
  } finally {
    restoreClock();
  }

  return { checks, skipped, ratios, datesAlreadyPresent: doneDates.size };
}
