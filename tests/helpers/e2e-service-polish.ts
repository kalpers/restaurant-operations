import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import { locations, locationSettings, menuItems, restaurantAreas, users } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createCategory, createItem, createMenu, createPlacement, setMenuLocation } from "../../src/modules/menu/services/catalog-service";
import { attachGroup, createGroup, createModifier, setGroupModifier } from "../../src/modules/menu/services/modifier-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import {
  changeTaxRate,
  createTaxCategory,
  getLocationTaxSetting,
  setLocationTaxEnabled,
} from "../../src/modules/menu/services/tax-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { seatParty } from "../../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { assignAt } from "./e2e-accounts";
import { createRoleAccount, uniqueCode, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 20 E2E: a location of this spec's own, with tax on (one rate included in prices, one
// added), a burger with a required doneness choice, and its own floor. Turning tax on or 86ing
// modifiers here never changes what other specs sell at MAIN. Accounts are disabled afterwards.

export const POLISH_SCOPE: E2eScope = {
  emailDomain: "polish-e2e.example.test",
  rolePrefix: "POLISH_E2E_",
  tablePrefix: "POL-",
};

export type PolishSetup = {
  locationId: string;
  owner: OrdersAccount;
  manager: OrdersAccount;
  cook: OrdersAccount;
  server: OrdersAccount;
  /** 11.00, tax 10% included in the price. */
  lemonade: { id: string; name: string };
  /** 10.00, tax 10% added; a required Medium / Well done choice. */
  burger: { id: string; name: string; groupId: string; medium: { id: string; name: string }; wellDone: { id: string; name: string } };
  areaId: string;
};

async function actorAt(account: OrdersAccount, locationId: string): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId });
}

async function account(roleCode: string, locationId: string): Promise<OrdersAccount> {
  const created = await createRoleAccount(roleCode, POLISH_SCOPE);

  await assignAt(created.id, roleCode, locationId);

  return created;
}

export async function createPolishSetup(): Promise<PolishSetup> {
  const database = getDatabase();
  const [main] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Polish ${randomUUID().slice(0, 8)}`,
      locationCode: `POL_${randomUUID()}`,
      timezone: "America/Detroit",
    })
    .returning({ id: locations.id });
  const locationId = location!.id;

  await database.insert(locationSettings).values({ locationId, cashDrawerRequired: false });

  const [area] = await database
    .insert(restaurantAreas)
    .values({ locationId, code: "DINING_ROOM", name: "Dining room", areaType: "DINING" })
    .returning({ id: restaurantAreas.id });
  const owner = await account("OWNER", locationId);
  const manager = await account("MANAGER", locationId);
  const cook = await account("COOK", locationId);
  const server = await account("SERVER", locationId);
  const actor = await actorAt(owner, locationId);
  const suffix = randomUUID().slice(0, 6);

  // Tax on: drinks priced with tax included, food with tax added.
  const taxCategory = async (name: string, included: boolean) => {
    const category = await createTaxCategory(database, actor, { code: uniqueCode(), name, description: null });

    await changeTaxRate(database, actor, {
      taxCategoryId: category.id,
      ratePercent: "10",
      priceIncludesTax: included,
      effectiveFrom: null,
    });

    return category.id;
  };
  const drinksTax = await taxCategory(`E2E Drinks tax ${suffix}`, true);
  const foodTax = await taxCategory(`E2E Food tax ${suffix}`, false);
  const { version } = await getLocationTaxSetting(database, actor);

  await setLocationTaxEnabled(database, actor, { enabled: true, expectedVersion: version });

  const menu = await createMenu(database, actor, { code: uniqueCode(), name: `E2E Polish ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId, active: true });

  const category = await createCategory(database, actor, { code: uniqueCode(), name: `E2E Mains ${suffix}`, description: null, displayOrder: 0 });
  const sell = async (name: string, price: string, taxCategoryId: string) => {
    const item = await createItem(database, actor, {
      code: uniqueCode(),
      name,
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 0,
    });

    await changePrice(database, actor, item.id, { locationId: null, price, effectiveFrom: null }, new Date("2024-01-01T00:00:00Z"));
    await createPlacement(database, actor, { menuId: menu.id, menuCategoryId: category.id, menuItemId: item.id, displayOrder: 0 });
    await database.update(menuItems).set({ taxCategoryId }).where(eq(menuItems.id, item.id));

    return { id: item.id, name };
  };
  const lemonade = await sell(`E2E Lemonade ${suffix}`, "11.00", drinksTax);
  const burger = await sell(`E2E Burger ${suffix}`, "10.00", foodTax);
  const modifier = async (name: string) => {
    const created = await createModifier(database, actor, {
      code: uniqueCode(),
      name,
      description: null,
      priceAdjustment: "0.00",
      preparationEffectType: "INSTRUCTION",
      preparationInstruction: name,
    });

    return { id: created.id, name };
  };
  const medium = await modifier(`E2E Medium ${suffix}`);
  const wellDone = await modifier(`E2E Well done ${suffix}`);
  const group = await createGroup(database, actor, {
    code: uniqueCode(),
    name: `E2E Doneness ${suffix}`,
    description: null,
    selectionType: "REQUIRED_SINGLE",
    minimumSelections: 1,
    maximumSelections: 1,
    displayOrder: 0,
  });

  for (const [index, entry] of [medium, wellDone].entries()) {
    await setGroupModifier(database, actor, group.id, { modifierId: entry.id, displayOrder: index, active: true });
  }

  await attachGroup(database, actor, burger.id, {
    modifierGroupId: group.id,
    displayOrder: 0,
    requiredOverride: null,
    minimumOverride: null,
    maximumOverride: null,
  });

  return {
    locationId,
    owner,
    manager,
    cook,
    server,
    lemonade,
    burger: { ...burger, groupId: group.id, medium, wellDone },
    areaId: area!.id,
  };
}

/** A new table with a seated party, at this spec's location. */
export async function seatPolishParty(setup: PolishSetup) {
  const database = getDatabase();
  const actor = await actorAt(setup.owner, setup.locationId);
  const { id: tableId } = await createTable(database, actor, {
    restaurantAreaId: setup.areaId,
    tableNumber: `${POLISH_SCOPE.tablePrefix}${randomUUID().slice(0, 6)}`,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });
  const session = await seatParty(database, actor, { tableIds: [tableId], partySize: 2, serverEmployeeId: null });

  return session.id;
}

/** A dine-in check on the session with the given items sent. The burger is sent Medium. */
export async function sentCheck(setup: PolishSetup, sessionId: string, items: ("lemonade" | "burger")[]) {
  const database = getDatabase();
  const actor = await actorAt(setup.owner, setup.locationId);
  const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: sessionId });
  let version = order.version;

  for (const item of items) {
    version = (
      await addDraftItem(database, actor, order.id, {
        expectedVersion: version,
        menuItemId: setup[item].id,
        quantity: 1,
        selections: item === "burger" ? [{ modifierGroupId: setup.burger.groupId, modifierId: setup.burger.medium.id }] : [],
        specialInstructions: null,
      })
    ).orderVersion;
  }

  if (items.length > 0) {
    await sendOrderItems(database, actor, order.id, { expectedVersion: version, idempotencyKey: `e2e-${randomUUID()}` });
  }

  return order.id;
}

/** Settles a check by external card with the given tip, and closes it. */
export async function settleByCard(setup: PolishSetup, orderId: string, tipAmount: string | null = null) {
  const database = getDatabase();
  const actor = await actorAt(setup.owner, setup.locationId);
  const opened = await openSettlement(database, actor, orderId);
  const recorded = await recordTender(database, actor, opened.settlementId, {
    idempotencyKey: `e2e-${randomUUID()}`,
    expectedVersion: opened.settlementVersion,
    tenderType: "EXTERNAL_CARD",
    outcome: "RECORDED",
    amount: opened.orderAmountSnapshot,
    tipAmount,
    receivedAmount: null,
    externalReference: null,
    providerName: null,
    cardBrand: null,
    cardLastFour: null,
    authorizationReference: null,
    otherDescription: null,
    failureReason: null,
    cashDrawerSessionId: null,
  });

  await completeSettlement(database, actor, opened.settlementId, {
    expectedVersion: recorded.settlementVersion,
    idempotencyKey: `e2e-${randomUUID()}`,
  });

  return opened.orderAmountSnapshot;
}

export async function disablePolishAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${POLISH_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
