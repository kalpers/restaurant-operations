import { randomUUID } from "node:crypto";

import { and, count, eq, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  inventoryBalances,
  inventoryItemLocations,
  inventoryTransactions,
  locations,
  locationSettings,
  menuItemPrepRouting,
  menuItemPrices,
  menuLocations,
  onlineBookingPeriods,
  onlineBookingSettings,
  prepStations,
  restaurantAreas,
  restaurantTables,
  schedulingRules,
  taxRates,
  tipPoolRules,
  userRoles,
} from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { assignRole, searchPeopleToAdd } from "@/modules/auth/services/user-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { reactivateLocation } from "@/modules/organization/services/location-lifecycle-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { deactivateLocation } from "@/workflows/deactivate-location/deactivate-location";
import { voidOrder } from "@/workflows/void-order-item/void-order-item";
import { COPY_GROUPS, openLocation, type OpenLocationInput } from "@/workflows/open-location/open-location";

import { actorAt, createRoleFixture, createUserFixture } from "../../fixtures/auth-fixtures";
import { actorWith, createHrScenario } from "../../fixtures/employee-fixtures";
import { stockedItem, unitId } from "../../fixtures/inventory-fixtures";
import { itemFixture, menuFixture, priceFixture } from "../../fixtures/menu-fixtures";
import { taxCategoryWithRate } from "../../fixtures/tax-fixtures";

const database = () => getDatabase();
const code = () => `T${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
const fields = (locationCode = code()): Omit<OpenLocationInput, "copyFrom"> => ({
  name: `Location ${locationCode}`,
  locationCode,
  timezone: "America/Chicago",
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  country: "US",
  phone: null,
  email: null,
});
const countWhere = async (table: PgTable, where: SQL | undefined) =>
  (await database().select({ total: count() }).from(table).where(where))[0]!.total;

describe("opening and closing locations (Phase 23)", () => {
  let scenario: Awaited<ReturnType<typeof createHrScenario>>;
  let menuId: string;
  let itemId: string;
  let stockedId: string;
  let stationId: string;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
    const owner = scenario.owner;

    // Setup at location A to copy from.
    await database()
      .update(locationSettings)
      .set({ businessDayCutoff: "05:00:00", defaultWaitQuoteMinutes: 25 })
      .where(eq(locationSettings.locationId, scenario.locationA));
    const [station] = await database()
      .insert(prepStations)
      .values({ locationId: scenario.locationA, code: "GRILL", name: "Grill", stationType: "KITCHEN" })
      .returning({ id: prepStations.id });
    stationId = station!.id;
    menuId = (await menuFixture(database(), owner)).id;
    itemId = (await itemFixture(database(), owner)).id;
    await database().insert(menuItemPrepRouting).values({
      organizationId: scenario.organizationId,
      menuItemId: itemId,
      locationId: scenario.locationA,
      prepStationId: stationId,
    });
    await priceFixture(database(), owner, itemId, "12.50", { locationId: scenario.locationA });
    await taxCategoryWithRate(database(), owner, "6.0000");
    stockedId = (
      await stockedItem(database(), owner, {
        baseUnitId: await unitId(database(), "EACH"),
        levels: { parLevel: "10", reorderLevel: "4", reorderTarget: "12" },
      })
    ).id;
    await database().insert(schedulingRules).values({ locationId: scenario.locationA, weekStartDay: 0, minimumRestHours: "10.00" }).onConflictDoNothing();
    await database().insert(tipPoolRules).values({ organizationId: scenario.organizationId, locationId: scenario.locationA, name: "House pool" });
    await database().insert(onlineBookingSettings).values({ locationId: scenario.locationA, enabled: true, maxPartySize: 8 });
    await database().insert(onlineBookingPeriods).values({ locationId: scenario.locationA, weekday: 5, startsAt: "17:00:00", endsAt: "21:00:00" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("opens a location with defaults and gives only the creator access", async () => {
    const before = await countWhere(userRoles, eq(userRoles.userId, scenario.ownerUser.id));
    const { locationId, rolesCopied } = await openLocation(database(), scenario.owner, { ...fields(), copyFrom: null });

    const [settings] = await database().select().from(locationSettings).where(eq(locationSettings.locationId, locationId));
    expect(settings!.businessDayCutoff).toBe("04:00:00");
    expect(settings!.cashDrawerRequired).toBe(true);
    expect(await countWhere(restaurantAreas, eq(restaurantAreas.locationId, locationId))).toBe(3);
    expect(await countWhere(schedulingRules, eq(schedulingRules.locationId, locationId))).toBe(1);
    const [booking] = await database().select().from(onlineBookingSettings).where(eq(onlineBookingSettings.locationId, locationId));
    expect(booking!.enabled).toBe(false);
    expect(await countWhere(prepStations, eq(prepStations.locationId, locationId))).toBe(0);

    expect(rolesCopied).toBe(1);
    expect(await countWhere(userRoles, eq(userRoles.userId, scenario.ownerUser.id))).toBe(before + 1);
    expect(await countWhere(userRoles, eq(userRoles.locationId, locationId))).toBe(1);
    const context = await getUserAuthContext(database(), scenario.ownerUser.id);
    expect(context!.locations.map((location) => location.locationId)).toContain(locationId);

    const [audit] = await database()
      .select({ action: auditEvents.action, after: auditEvents.after })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, locationId), eq(auditEvents.action, "locations.created")));
    expect(audit!.after).toMatchObject({ rolesCopied: 1, copiedGroups: [] });
  });

  it("copies each setup group and nothing else", async () => {
    const now = new Date();
    const { locationId } = await openLocation(
      database(),
      scenario.owner,
      { ...fields(), copyFrom: { locationId: scenario.locationA, groups: COPY_GROUPS } },
      now,
    );

    const [settings] = await database().select().from(locationSettings).where(eq(locationSettings.locationId, locationId));
    expect(settings!.businessDayCutoff).toBe("05:00:00");
    expect(settings!.defaultWaitQuoteMinutes).toBe(25);
    expect(settings!.cashDrawerRequired).toBe(false);

    const [station] = await database().select().from(prepStations).where(eq(prepStations.locationId, locationId));
    expect(station).toMatchObject({ code: "GRILL", name: "Grill", stationType: "KITCHEN" });
    const [route] = await database().select().from(menuItemPrepRouting).where(eq(menuItemPrepRouting.locationId, locationId));
    expect(route).toMatchObject({ menuItemId: itemId, prepStationId: station!.id });

    expect(await countWhere(menuLocations, and(eq(menuLocations.locationId, locationId), eq(menuLocations.menuId, menuId)))).toBe(1);
    const [price] = await database().select().from(menuItemPrices).where(eq(menuItemPrices.locationId, locationId));
    expect(price).toMatchObject({ menuItemId: itemId, price: "12.50", effectiveTo: null });
    expect(price!.effectiveFrom.getTime()).toBe(now.getTime());
    const [rate] = await database().select().from(taxRates).where(eq(taxRates.locationId, locationId));
    expect(rate!.ratePercent).toBe("6.0000");

    const [stocked] = await database().select().from(inventoryItemLocations).where(eq(inventoryItemLocations.locationId, locationId));
    expect(stocked).toMatchObject({ inventoryItemId: stockedId, parLevel: "10.0000", reorderLevel: "4.0000" });
    expect(await countWhere(inventoryBalances, eq(inventoryBalances.locationId, locationId))).toBe(0);
    expect(await countWhere(inventoryTransactions, eq(inventoryTransactions.locationId, locationId))).toBe(0);

    const [rules] = await database().select().from(schedulingRules).where(eq(schedulingRules.locationId, locationId));
    expect(rules).toMatchObject({ weekStartDay: 0, minimumRestHours: "10.00" });
    expect(await countWhere(tipPoolRules, eq(tipPoolRules.locationId, locationId))).toBe(1);
    const [booking] = await database().select().from(onlineBookingSettings).where(eq(onlineBookingSettings.locationId, locationId));
    expect(booking).toMatchObject({ enabled: false, maxPartySize: 8 });
    expect(await countWhere(onlineBookingPeriods, eq(onlineBookingPeriods.locationId, locationId))).toBe(1);

    // Never copied: tables, other people's access.
    expect(await countWhere(restaurantTables, eq(restaurantTables.locationId, locationId))).toBe(0);
    expect(await countWhere(userRoles, eq(userRoles.locationId, locationId))).toBe(1);

    // The source is unchanged.
    expect(await countWhere(prepStations, eq(prepStations.locationId, scenario.locationA))).toBe(1);
  });

  it("refuses a code already in use, and leaves nothing behind", async () => {
    const taken = code();
    await openLocation(database(), scenario.owner, { ...fields(taken), copyFrom: null });
    const before = await countWhere(locations, eq(locations.organizationId, scenario.organizationId));

    await expect(openLocation(database(), scenario.owner, { ...fields(taken), copyFrom: null })).rejects.toMatchObject({
      code: "LOCATION_CODE_TAKEN",
    });
    expect(await countWhere(locations, eq(locations.organizationId, scenario.organizationId))).toBe(before);
  });

  it("needs locations.lifecycle, and locations.view at the source", async () => {
    const viewer = await actorWith(database(), scenario, ["locations.view"]);
    await expect(openLocation(database(), viewer, { ...fields(), copyFrom: null })).rejects.toBeInstanceOf(AuthorizationError);

    // Holds the lifecycle permission at B only, so can't copy from A.
    const role = await createRoleFixture(database(), scenario.organizationId, ["locations.lifecycle", "locations.view"]);
    const user = await createUserFixture(database(), { assignments: [{ roleId: role, locationId: scenario.locationB }] });
    const atB = await actorAt(database(), user.id, scenario.locationB, "locations.lifecycle");
    await expect(
      openLocation(database(), atB, { ...fields(), copyFrom: { locationId: scenario.locationA, groups: ["PRICES"] } }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses closing a location with open checks, then closes and reopens it", async () => {
    const { locationId } = await openLocation(database(), scenario.owner, { ...fields(), copyFrom: null });
    const there = await actorAt(database(), scenario.ownerUser.id, locationId, "orders.void");
    const order = await createOrder(database(), there, { orderType: "TAKEOUT", customerName: null });
    const version = async () => (await database().select({ version: locations.version }).from(locations).where(eq(locations.id, locationId)))[0]!.version;

    await expect(
      deactivateLocation(database(), scenario.owner, { locationId, expectedVersion: await version() }),
    ).rejects.toMatchObject({ code: "LOCATION_HAS_OPEN_WORK", details: { open: ["open checks"] } });

    // Close the check so nothing is open.
    await voidOrder(database(), there, order.id, { reason: "Test", expectedVersion: order.version, dispositions: {} });

    await expect(
      deactivateLocation(database(), scenario.owner, { locationId, expectedVersion: (await version()) - 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

    const closed = await deactivateLocation(database(), scenario.owner, { locationId, expectedVersion: await version() });
    const context = await getUserAuthContext(database(), scenario.ownerUser.id);
    expect(context!.locations.map((location) => location.locationId)).not.toContain(locationId);

    await reactivateLocation(database(), scenario.owner, { locationId, expectedVersion: closed.version });
    const reopened = await getUserAuthContext(database(), scenario.ownerUser.id);
    expect(reopened!.locations.map((location) => location.locationId)).toContain(locationId);
    const [booking] = await database().select().from(onlineBookingSettings).where(eq(onlineBookingSettings.locationId, locationId));
    expect(booking!.enabled).toBe(false);
  });

  it("never closes the last active location", async () => {
    const solo = await createHrScenario(database());
    await database().update(locations).set({ active: false }).where(eq(locations.id, solo.locationB));
    const [row] = await database().select({ version: locations.version }).from(locations).where(eq(locations.id, solo.locationA));

    await expect(
      deactivateLocation(database(), solo.owner, { locationId: solo.locationA, expectedVersion: row!.version }),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_LOCATION" });
  });

  it("finds people in the organization to add at a location, and only them", async () => {
    const role = await createRoleFixture(database(), scenario.organizationId, ["menu.view"]);
    const atB = await createUserFixture(database(), { assignments: [{ roleId: role, locationId: scenario.locationB }] });
    const outsider = await createHrScenario(database());

    const found = await searchPeopleToAdd(database(), scenario.owner, atB.email.slice(0, 12));
    expect(found.map((person) => person.id)).toContain(atB.id);
    expect(found.map((person) => person.id)).not.toContain(scenario.ownerUser.id);

    await assignRole(database(), scenario.owner, { userId: atB.id, roleId: role });
    expect(await searchPeopleToAdd(database(), scenario.owner, atB.email.slice(0, 12))).toEqual([]);

    // Someone from another organization can't be given a role here.
    await expect(
      assignRole(database(), scenario.owner, { userId: outsider.ownerUser.id, roleId: role }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
