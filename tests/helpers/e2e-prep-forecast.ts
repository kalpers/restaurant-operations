import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import { locations, roles, unitsOfMeasure, userRoles, users } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createItem as createInventoryItem, getItemConfiguration, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { recordAdjustment } from "../../src/modules/inventory/services/stock-operations";
import { createSupplier, createSupplierItem } from "../../src/modules/inventory/services/supplier-service";
import {
  createItem as createMenuItem,
  createPlacement,
  listCategories,
  listMenus,
} from "../../src/modules/menu/services/catalog-service";
import { createStation, setItemRouting } from "../../src/modules/menu/services/prep-station-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { addIngredient } from "../../src/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, publishRevision } from "../../src/modules/recipes/services/recipe-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { addDays, localToInstant } from "../../src/shared/time/zoned-time";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { createRoleAccount, type E2eScope } from "./e2e-orders";

loadLocalEnv();
pointAtTestDatabase();

// Phase 25 E2E: a burger with its own grill station, patty stock and supplier at MAIN, and
// three past same-weekday takeout checks selling 4 burgers each, so the prep list and the
// forecast-based suggestion have history. Everything goes through the real services with this
// process's clock moved back; the app's clock is untouched. Names carry a run suffix so specs
// and reruns never collide.

export const PREP_SCOPE: E2eScope = {
  emailDomain: "prep-e2e.example.test",
  rolePrefix: "PREP_E2E_",
  tablePrefix: "PRP-",
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

export type PrepFixture = {
  /** Three days ahead, in the location's zone: the date the prep list and suggestion use. */
  target: string;
  burgerName: string;
  pattyName: string;
  stationName: string;
};

/**
 * The fixture: 20 patties received, 12 sold over three past same-weekday dates (4 each), so the
 * target date forecasts 4 burgers and 8 patties are left. Reorder level 5, target 30: not low
 * by par (8 > 5), but the forecast needs 4 + 5 − 8 = 1 more.
 */
export async function createPrepFixture(): Promise<PrepFixture> {
  const database = getDatabase();
  const [location] = await database
    .select({ id: locations.id, timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));
  const owner = await createRoleAccount("OWNER", PREP_SCOPE);
  const context = await getUserAuthContext(database, owner.id);
  const actor: Actor = requirePermission(context!, { permission: "menu.edit", locationId: location!.id });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: location!.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const target = addDays(today, 3);
  const history = [21, 14, 7].map((days) => addDays(target, -days));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const names = {
    burgerName: `Prep E2E burger ${suffix}`,
    pattyName: `Prep E2E patty ${suffix}`,
    stationName: `Prep E2E grill ${suffix}`,
  };
  const [each] = await database.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, "EACH"));

  try {
    shiftClockTo(localToInstant(addDays(history[0]!, -1), "10:00", location!.timezone)!);

    const patty = await createInventoryItem(database, actor, {
      code: `PRPE2E_${suffix}`,
      name: names.pattyName,
      description: null,
      measurementType: "COUNT",
      baseUnitId: each!.id,
    });
    const supplier = await createSupplier(database, actor, {
      code: `PRPSUP_${suffix}`,
      name: `Prep E2E supplier ${suffix}`,
      contactName: null,
      phone: null,
      email: null,
    });
    const supplierItem = await createSupplierItem(database, actor, supplier.id, {
      inventoryItemId: patty.id,
      purchaseUnitId: each!.id,
      supplierSku: null,
      lastUnitCost: "1.5000",
    });

    await setItemLocation(database, actor, patty.id, {
      parLevel: "30",
      reorderLevel: "5",
      reorderTarget: "30",
      storageNote: null,
      active: true,
      expectedVersion: null,
    });

    const config = await getItemConfiguration(database, actor, patty.id);
    const here = config.locations.find((row) => row.locationId === location!.id)!;

    await setItemLocation(database, actor, patty.id, {
      parLevel: "30",
      reorderLevel: "5",
      reorderTarget: "30",
      storageNote: null,
      active: true,
      preferredSupplierItemId: supplierItem.id,
      expectedVersion: here.version,
    });
    await recordAdjustment(database, actor, {
      inventoryItemId: patty.id,
      direction: "INCREASE",
      reasonCode: "FOUND_STOCK",
      quantity: "20",
      unitOfMeasureId: each!.id,
      notes: "Prep E2E stock",
    });

    const station = await createStation(database, actor, {
      code: `PRPGRL_${suffix}`,
      name: names.stationName,
      stationType: "KITCHEN",
      sortOrder: 99,
    });
    const burger = await createMenuItem(database, actor, {
      code: `PRPBRG_${suffix}`,
      name: names.burgerName,
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 9992,
    });
    const [menu] = (await listMenus(database, actor)).filter((row) => row.code === "MAIN");
    const [category] = await listCategories(database, actor);

    await changePrice(database, actor, burger.id, { locationId: null, price: "12.00", effectiveFrom: null });
    await createPlacement(database, actor, { menuId: menu!.id, menuCategoryId: category!.id, menuItemId: burger.id, displayOrder: 9992 });
    await setItemRouting(database, actor, burger.id, { prepStationIds: [station.id] });

    const recipe = await createRecipe(database, actor, { code: `PRPRCP_${suffix}`, name: names.burgerName, description: null, menuItemId: burger.id });
    const draft = await createDraftRevision(database, actor, recipe.id, { yieldQuantity: "1", yieldUnitId: each!.id, preparationNotes: null });
    const added = await addIngredient(database, actor, recipe.id, draft.id, {
      inventoryItemId: patty.id,
      quantity: "1",
      unitOfMeasureId: each!.id,
      preparationNote: null,
      sortOrder: 0,
      expectedVersion: draft.version,
    });

    await publishRevision(database, actor, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: added.revisionVersion });

    for (const date of history) {
      shiftClockTo(localToInstant(date, "18:30", location!.timezone)!);

      const order = await createOrder(database, actor, { orderType: "TAKEOUT", customerName: "Prep E2E" });
      const drafted = await addDraftItem(database, actor, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.id,
        quantity: 4,
        selections: [],
        specialInstructions: null,
      });

      await sendOrderItems(database, actor, order.id, { expectedVersion: drafted.orderVersion, idempotencyKey: `e2e-${randomUUID()}` });

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
    }
  } finally {
    restoreClock();
  }

  return { target, ...names };
}

/**
 * Disables the spec's accounts and removes their roles. The checks, their kitchen tickets, the
 * items and the stored forecast stay, as history does (the E2E database is rebuilt each run).
 */
export async function removePrepE2eData(): Promise<void> {
  const database = getDatabase();
  const userIds = (
    await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${PREP_SCOPE.emailDomain}`))
  ).map((row) => row.id);

  if (userIds.length > 0) {
    await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
    await database
      .delete(roles)
      .where(like(roles.code, `${PREP_SCOPE.rolePrefix}%`))
      .catch(() => undefined);
    await database.update(users).set({ active: false, disabledAt: new Date() }).where(inArray(users.id, userIds));
  }

  await closeDatabase();
}
