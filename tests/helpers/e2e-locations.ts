import { randomUUID } from "node:crypto";

import { expect, type Browser, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { locations, unitsOfMeasure } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { createItem, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { openLocation } from "../../src/workflows/open-location/open-location";
import { assignAt } from "./e2e-accounts";
import { createRoleAccount, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 23 E2E data: its own email domain and item codes, so no other spec's cleanup touches
// the transfers, lots and ledger rows these specs leave (the E2E database is recreated each run).

export const LOCATIONS_SCOPE: E2eScope = {
  emailDomain: "locations-e2e.example.test",
  rolePrefix: "LOCATIONS_E2E_",
  tablePrefix: "LOC-",
};

export const shortCode = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

export async function mainLocationId(): Promise<string> {
  const [main] = await getDatabase().select({ id: locations.id }).from(locations).where(eq(locations.locationCode, "MAIN"));

  return main!.id;
}

export async function locationIdByName(name: string): Promise<string> {
  const [row] = await getDatabase().select({ id: locations.id }).from(locations).where(eq(locations.name, name));

  return row!.id;
}

/** An Owner at MAIN only. */
export function createOwner(): Promise<OrdersAccount> {
  return createRoleAccount("OWNER", LOCATIONS_SCOPE);
}

/** A second location opened from MAIN by this Owner (the Owner gets their roles there). */
export async function openSecondLocation(owner: OrdersAccount, name: string): Promise<string> {
  const context = await getUserAuthContext(getDatabase(), owner.id);
  const actor = requirePermission(context!, { permission: "locations.lifecycle", locationId: await mainLocationId() });
  const { locationId } = await openLocation(getDatabase(), actor, {
    name,
    locationCode: shortCode("LE"),
    timezone: "America/Detroit",
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: "US",
    phone: null,
    email: null,
    copyFrom: null,
  });

  return locationId;
}

/** An EACH item stocked at the given locations, created by the Owner at MAIN. */
export async function stockedEverywhere(owner: OrdersAccount, name: string, locationIds: readonly string[]) {
  const context = await getUserAuthContext(getDatabase(), owner.id);
  const [each] = await getDatabase().select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, "EACH"));
  const atMain = requirePermission(context!, { permission: "inventory.configure", locationId: await mainLocationId() });
  const item = await createItem(getDatabase(), atMain, {
    code: shortCode("E2EL_"),
    name,
    description: null,
    measurementType: "COUNT",
    baseUnitId: each!.id,
  });

  for (const locationId of locationIds) {
    await setItemLocation(getDatabase(), requirePermission(context!, { permission: "inventory.configure", locationId }), item.id, {
      parLevel: null,
      reorderLevel: null,
      reorderTarget: null,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });
  }

  return item;
}

export async function signedIn(browser: Browser, account: OrdersAccount, locationId?: string): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  if (locationId) {
    expect((await page.request.put("/api/session/location", { data: { locationId } })).ok()).toBe(true);
  }

  return page;
}

export { assignAt };
