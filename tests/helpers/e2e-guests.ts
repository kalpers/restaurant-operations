import { randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import { allergens, guestParties, locations, locationSettings, restaurantAreas, users } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createCategory, createItem, createMenu, createPlacement, setMenuLocation } from "../../src/modules/menu/services/catalog-service";
import { createStation, setItemRouting } from "../../src/modules/menu/services/prep-station-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { setMenuItemAllergens } from "../../src/modules/recipes/services/allergen-service";
import { createGuestProfile } from "../../src/modules/reservations/services/guest-profile-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { seatParty } from "../../src/workflows/seat-party/seat-party";

import { assignAt } from "./e2e-accounts";
import { createRoleAccount, uniqueCode, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 21 E2E: a location of this spec's own, with a peanut satay (declared CONTAINS peanuts,
// routed to a kitchen station) and a plain bread item with no recipe and no allergen review.
// Accounts are disabled afterwards; profiles stay as records, like other specs' history.

export const GUESTS_SCOPE: E2eScope = {
  emailDomain: "guests-e2e.example.test",
  rolePrefix: "GUESTS_E2E_",
  tablePrefix: "GST-",
};

export type GuestsSetup = {
  locationId: string;
  owner: OrdersAccount;
  manager: OrdersAccount;
  host: OrdersAccount;
  server: OrdersAccount;
  cook: OrdersAccount;
  satay: { id: string; name: string };
  bread: { id: string; name: string };
  areaId: string;
  suffix: string;
};

async function actorAt(account: OrdersAccount, locationId: string): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId });
}

async function account(roleCode: string, locationId: string): Promise<OrdersAccount> {
  const created = await createRoleAccount(roleCode, GUESTS_SCOPE);

  await assignAt(created.id, roleCode, locationId);

  return created;
}

export async function allergenId(code: string): Promise<string> {
  const [row] = await getDatabase().select({ id: allergens.id }).from(allergens).where(eq(allergens.code, code));

  return row!.id;
}

export async function createGuestsSetup(): Promise<GuestsSetup> {
  const database = getDatabase();
  const [main] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Guests ${randomUUID().slice(0, 8)}`,
      locationCode: `GST_${randomUUID()}`,
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
  const host = await account("HOST", locationId);
  const server = await account("SERVER", locationId);
  const cook = await account("COOK", locationId);
  const actor = await actorAt(owner, locationId);
  const suffix = randomUUID().slice(0, 6);
  const menu = await createMenu(database, actor, { code: uniqueCode(), name: `E2E Guests ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId, active: true });

  const category = await createCategory(database, actor, { code: uniqueCode(), name: `E2E Plates ${suffix}`, description: null, displayOrder: 0 });
  const station = await createStation(database, actor, {
    code: uniqueCode(),
    name: `E2E Line ${suffix}`,
    stationType: "KITCHEN",
    sortOrder: 0,
  });
  const sell = async (name: string, price: string) => {
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
    await setItemRouting(database, actor, item.id, { prepStationIds: [station.id] });

    return { id: item.id, name };
  };
  const satay = await sell(`E2E Chicken satay ${suffix}`, "12.00");
  const bread = await sell(`E2E House bread ${suffix}`, "4.00");

  await setMenuItemAllergens(database, actor, {
    menuItemId: satay.id,
    declared: [{ allergenId: await allergenId("PEANUTS"), kind: "CONTAINS" }],
    expectedReviewVersion: null,
  });

  return { locationId, owner, manager, host, server, cook, satay, bread, areaId: area!.id, suffix };
}

/** The party the host's walk-in created, found by its guest name at this location. */
export async function partyNamed(setup: GuestsSetup, guestName: string) {
  const [party] = await getDatabase()
    .select()
    .from(guestParties)
    .where(and(eq(guestParties.locationId, setup.locationId), eq(guestParties.guestName, guestName)));

  return party!;
}

/** Seats a party at a new table and opens its check with one draft item. */
export async function seatWithDraft(setup: GuestsSetup, guestPartyId: string, menuItemId: string) {
  const database = getDatabase();
  const actor = await actorAt(setup.owner, setup.locationId);
  const { id: tableId } = await createTable(database, actor, {
    restaurantAreaId: setup.areaId,
    tableNumber: `${GUESTS_SCOPE.tablePrefix}${randomUUID().slice(0, 6)}`,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });
  const session = await seatParty(database, actor, { tableIds: [tableId], partySize: 2, serverEmployeeId: null, guestPartyId });
  const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: session.id });

  await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId,
    quantity: 1,
    selections: [],
    specialInstructions: null,
  });

  return order.id;
}

export async function profileFor(setup: GuestsSetup, displayName: string) {
  return createGuestProfile(getDatabase(), await actorAt(setup.owner, setup.locationId), {
    displayName,
    phone: null,
    email: null,
    vip: false,
    vipReason: null,
    preferences: null,
    notes: null,
    otherDietaryNeeds: null,
  });
}

export async function disableGuestsAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${GUESTS_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
