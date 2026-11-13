import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { getDatabase } from "../../src/db";
import {
  demandExcludedDates,
  locations,
  orders,
  restaurantAreas,
  staffingRatios,
} from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import {
  createItem as createMenuItem,
  createPlacement,
  listCategories,
  listMenus,
} from "../../src/modules/menu/services/catalog-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { addRequirement, createTemplate } from "../../src/modules/scheduling/services/config-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { addDays, localToInstant } from "../../src/shared/time/zoned-time";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { seatParty } from "../../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { createRoleAccount, removeOrdersE2eData, type E2eScope } from "./e2e-orders";

loadLocalEnv();
pointAtTestDatabase();

// Phase 24 E2E: closed checks on past dates at MAIN, so the app has history to forecast from.
// They go through the real services with this process's clock moved back to each check's
// time; the app's own clock is untouched. Cleanup removes the checks, tables and accounts by
// this scope, and the ratios and excluded dates at MAIN.

export const FORECAST_SCOPE: E2eScope = {
  emailDomain: "forecast-e2e.example.test",
  rolePrefix: "FORECAST_E2E_",
  tablePrefix: "FCT-",
};

const RealDate = Date;
let offsetMs = 0;

function shiftClockTo(instant: Date): void {
  if (globalThis.Date === RealDate) {
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

  offsetMs = instant.getTime() - RealDate.now();
}

function restoreClock(): void {
  globalThis.Date = RealDate;
  offsetMs = 0;
}

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function ownerActor(userId: string): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), userId);

  return requirePermission(context!, { permission: "menu.edit", locationId: location.id });
}

/**
 * Two dine-in checks (parties of 4 and 6) at 19:10 and 19:30 on each of `dates`, at MAIN.
 * Paid by external card, so no cash drawer is needed. Returns the check count.
 */
export async function createForecastHistory(dates: readonly string[]): Promise<number> {
  const database = getDatabase();
  const owner = await createRoleAccount("OWNER", FORECAST_SCOPE);
  const actor = await ownerActor(owner.id);
  const location = await mainLocation();
  const [dining] = await database
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(and(eq(restaurantAreas.locationId, location.id), eq(restaurantAreas.areaType, "DINING")));
  const [menu] = (await listMenus(database, actor)).filter((row) => row.code === "MAIN");
  const [category] = await listCategories(database, actor);
  const sorted = [...dates].sort();
  let count = 0;

  try {
    // The item exists, with its price, before the first history date.
    shiftClockTo(localToInstant(addDays(sorted[0]!, -1), "10:00", location.timezone)!);

    const item = await createMenuItem(database, actor, {
      code: `E2EF_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      name: "Forecast E2E plate",
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 9991,
    });

    await changePrice(database, actor, item.id, { locationId: null, price: "10.00", effectiveFrom: null });
    await createPlacement(database, actor, {
      menuId: menu!.id,
      menuCategoryId: category!.id,
      menuItemId: item.id,
      displayOrder: 9991,
    });

    for (const date of sorted) {
      for (const [time, partySize] of [["19:10", 4], ["19:30", 6]] as const) {
        shiftClockTo(localToInstant(date, time, location.timezone)!);

        const { id: tableId } = await createTable(database, actor, {
          restaurantAreaId: dining!.id,
          tableNumber: `${FORECAST_SCOPE.tablePrefix}${randomUUID().slice(0, 6)}`,
          name: null,
          capacity: 6,
          minimumCapacity: null,
          sortOrder: null,
        });
        const session = await seatParty(database, actor, { tableIds: [tableId], partySize, serverEmployeeId: null });
        const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: session.id });
        const drafted = await addDraftItem(database, actor, order.id, {
          expectedVersion: order.version,
          menuItemId: item.id,
          quantity: 1,
          selections: [],
          specialInstructions: null,
        });

        await sendOrderItems(database, actor, order.id, {
          expectedVersion: drafted.orderVersion,
          idempotencyKey: `e2e-${randomUUID()}`,
        });

        const opened = await openSettlement(database, actor, order.id);
        const recorded = await recordTender(database, actor, opened.settlementId, {
          idempotencyKey: `e2e-${randomUUID()}`,
          expectedVersion: opened.settlementVersion,
          tenderType: "EXTERNAL_CARD",
          outcome: "RECORDED",
          amount: opened.orderAmountSnapshot,
          tipAmount: null,
          receivedAmount: null,
          externalReference: null,
          providerName: null,
          cardBrand: null,
          cardLastFour: null,
          authorizationReference: null,
          otherDescription: null,
          failureReason: null,
        });

        await completeSettlement(database, actor, opened.settlementId, {
          expectedVersion: recorded.settlementVersion,
          idempotencyKey: `e2e-${randomUUID()}`,
        });
        count += 1;
      }
    }
  } finally {
    restoreClock();
  }

  const [closed] = await database
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.locationId, location.id), eq(orders.status, "CLOSED"), eq(orders.businessDate, sorted[0]!)));

  if (!closed) {
    throw new Error("The forecast history wasn't written on its business date.");
  }

  return count;
}

/**
 * The Monday to forecast (at least two days ahead) and the four Mondays before yesterday
 * to use as its history, so time zones can't put a history date on today's business date.
 */
export function forecastDates(): { monday: string; sunday: string; history: string[] } {
  const day = 86_400_000;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let target = today + 2 * day;

  while (new Date(target).getUTCDay() !== 1) {
    target += day;
  }

  let past = today - 2 * day;

  while (new Date(past).getUTCDay() !== 1) {
    past -= day;
  }

  return {
    monday: iso(target),
    sunday: iso(target + 6 * day),
    history: [0, 1, 2, 3].map((week) => iso(past - week * 7 * day)),
  };
}

/** A template asking for one Server on Mondays 17:00 to 22:00, through the service. */
export async function createMondayServerTemplate(owner: { id: string }, serverPositionId: string): Promise<string> {
  const actor = await ownerActor(owner.id);
  const template = await createTemplate(getDatabase(), actor, {
    name: `E2E Forecast ${randomUUID().slice(0, 8)}`,
    description: null,
  });

  await addRequirement(getDatabase(), actor, template.id, {
    dayOfWeek: 1,
    positionId: serverPositionId,
    restaurantAreaId: null,
    startTime: "17:00",
    endTime: "22:00",
    requiredEmployeeCount: 1,
    priority: 0,
  });

  return template.id;
}

/**
 * Removes the history checks, tables and accounts, and the ratios and excluded dates at
 * MAIN (only this spec creates those). Templates and periods go with the scheduling cleanup.
 */
export async function removeForecastE2eData(): Promise<void> {
  const location = await mainLocation();

  await getDatabase().delete(staffingRatios).where(eq(staffingRatios.locationId, location.id));
  await getDatabase().delete(demandExcludedDates).where(eq(demandExcludedDates.locationId, location.id));
  await removeOrdersE2eData(FORECAST_SCOPE);
}

