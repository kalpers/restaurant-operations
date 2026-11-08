import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import {
  addAvailabilityWindow,
  createPlacement,
  setMenuLocation,
  updateCategory,
  updateItem,
  updateMenu,
  updatePlacement,
} from "@/modules/menu/services/catalog-service";
import { updateGroup, updateModifier } from "@/modules/menu/services/modifier-service";
import { createStation, setItemRouting } from "@/modules/menu/services/prep-station-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import {
  attachGroupWith,
  categoryFixture,
  createMenuScenario,
  itemFixture,
  menuFixture,
  modifierFixture,
  priceFixture,
  sellableItem,
  uniqueCode,
  type MenuScenario,
} from "../../fixtures/menu-fixtures";

const database = () => getDatabase();

describe("operational menu query (the contract Phase 9 order entry will read)", () => {
  let scenario: MenuScenario;

  beforeEach(async () => {
    scenario = await createMenuScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const read = (at?: Date) => getOperationalMenu(database(), scenario.viewer, at);
  const itemsOf = async (at?: Date) =>
    (await read(at)).menus.flatMap((menu) =>
      menu.categories.flatMap((category) => category.items),
    );

  it("returns an available item with its placement, exact price, groups and constraints", async () => {
    const { menu, category, item } = await sellableItem(database(), scenario.admin, {
      price: "14.99",
    });
    const bacon = await modifierFixture(database(), scenario.admin, { priceAdjustment: "2.00" });
    const { group } = await attachGroupWith(
      database(),
      scenario.admin,
      item.id,
      "OPTIONAL_MULTIPLE",
      [bacon.id],
      { maximumSelections: 2 },
    );
    const station = await createStation(database(), scenario.admin, {
      code: uniqueCode("ST"),
      name: "Grill",
      stationType: "KITCHEN",
      sortOrder: 0,
    });

    await setItemRouting(database(), scenario.admin, item.id, { prepStationIds: [station.id] });

    const result = await read();
    const listed = result.menus.find((entry) => entry.id === menu.id);
    const [entry] = listed!.categories.find((entry) => entry.id === category.id)!.items;

    expect(result.locationId).toBe(scenario.locationA);
    expect(entry).toMatchObject({
      menuItemId: item.id,
      price: "14.99",
      priceScope: "ORGANIZATION",
      prepStationIds: [station.id],
    });
    expect(entry!.modifierGroups).toEqual([
      expect.objectContaining({
        id: group.id,
        selectionType: "OPTIONAL_MULTIPLE",
        minimumSelections: 0,
        maximumSelections: 2,
        modifiers: [expect.objectContaining({ id: bacon.id, priceAdjustment: "2.00" })],
      }),
    ]);
  });

  it("excludes unavailable items, inactive items, inactive placements and unpriced items", async () => {
    const menu = await menuFixture(database(), scenario.admin);
    const category = await categoryFixture(database(), scenario.admin);
    const place = async (name: string, options: { price?: boolean } = {}) => {
      const item = await itemFixture(database(), scenario.admin, { name });

      if (options.price ?? true) {
        await priceFixture(database(), scenario.admin, item.id, "5.00");
      }

      const placement = await createPlacement(database(), scenario.admin, {
        menuId: menu.id,
        menuCategoryId: category.id,
        menuItemId: item.id,
        displayOrder: 0,
      });

      return { item, placement };
    };
    await place("Offered");
    const eightySixed = await place("EightySixed");
    const retired = await place("Retired");
    const hidden = await place("Hidden");

    await place("Unpriced", { price: false });

    const edit = (
      item: { id: string; name: string; version: number },
      changes: { active?: boolean; available?: boolean },
    ) =>
      updateItem(database(), scenario.admin, item.id, {
        name: item.name,
        shortName: null,
        description: null,
        itemType: "FOOD",
        displayOrder: 0,
        active: changes.active ?? true,
        available: changes.available ?? true,
        expectedVersion: item.version,
      });

    await edit(eightySixed.item, { available: false });
    await edit(retired.item, { active: false });
    await updatePlacement(database(), scenario.admin, hidden.placement.id, {
      displayOrder: 0,
      active: false,
      expectedVersion: hidden.placement.version,
    });

    const names = (await itemsOf()).map((entry) => entry.name);

    expect(names.filter((name) => ["Offered", "EightySixed", "Retired", "Hidden", "Unpriced"].includes(name))).toEqual(["Offered"]);
  });

  it("excludes items of inactive categories and inactive menus", async () => {
    const { menu, category, item } = await sellableItem(database(), scenario.admin);

    expect((await itemsOf()).map((entry) => entry.menuItemId)).toContain(item.id);

    await updateCategory(database(), scenario.admin, category.id, {
      name: category.name,
      description: null,
      displayOrder: 0,
      active: false,
      expectedVersion: category.version,
    });
    expect((await itemsOf()).map((entry) => entry.menuItemId)).not.toContain(item.id);

    await updateMenu(database(), scenario.admin, menu.id, {
      name: menu.name,
      description: null,
      displayOrder: 0,
      active: false,
      expectedVersion: menu.version,
    });
    expect((await read()).menus.map((entry) => entry.id)).not.toContain(menu.id);
  });

  it("offers a menu only at locations where it is active", async () => {
    const { menu } = await sellableItem(database(), scenario.admin);

    await setMenuLocation(database(), scenario.admin, menu.id, {
      locationId: scenario.locationA,
      active: false,
    });

    expect((await read()).menus.map((entry) => entry.id)).not.toContain(menu.id);
  });

  it("respects menu availability windows, with half-open boundaries", async () => {
    const { menu, item } = await sellableItem(database(), scenario.admin);

    await addAvailabilityWindow(database(), scenario.admin, menu.id, {
      locationId: scenario.locationA,
      effectiveFrom: new Date("2030-01-01T00:00:00Z"),
      effectiveTo: new Date("2030-02-01T00:00:00Z"),
    });

    const offeredAt = async (iso: string) =>
      (await itemsOf(new Date(iso))).some((entry) => entry.menuItemId === item.id);

    expect(await offeredAt("2029-12-31T23:59:59.999Z")).toBe(false);
    expect(await offeredAt("2030-01-01T00:00:00Z")).toBe(true);
    expect(await offeredAt("2030-01-31T23:59:59.999Z")).toBe(true);
    expect(await offeredAt("2030-02-01T00:00:00Z")).toBe(false);
  });

  it("resolves the price at the requested instant, preferring the location price", async () => {
    const { item } = await sellableItem(database(), scenario.admin, { price: "10.00" });

    await priceFixture(database(), scenario.admin, item.id, "12.00", {
      locationId: scenario.locationA,
    });

    const [entry] = (await itemsOf()).filter((row) => row.menuItemId === item.id);

    expect(entry).toMatchObject({ price: "12.00", priceScope: "LOCATION" });
  });

  it("excludes inactive groups and inactive modifiers", async () => {
    const { item } = await sellableItem(database(), scenario.admin);
    const kept = await modifierFixture(database(), scenario.admin);
    const dropped = await modifierFixture(database(), scenario.admin);
    const { group } = await attachGroupWith(database(), scenario.admin, item.id, "OPTIONAL_MULTIPLE", [
      kept.id,
      dropped.id,
    ]);

    await updateModifier(database(), scenario.admin, dropped.id, {
      name: dropped.name,
      description: null,
      priceAdjustment: "0.00",
      preparationEffectType: "NONE",
      preparationInstruction: null,
      active: false,
      expectedVersion: dropped.version,
    });

    const [entry] = (await itemsOf()).filter((row) => row.menuItemId === item.id);

    expect(entry!.modifierGroups[0]!.modifiers.map((modifier) => modifier.id)).toEqual([kept.id]);

    await updateGroup(database(), scenario.admin, group.id, {
      name: group.name,
      description: null,
      selectionType: "OPTIONAL_MULTIPLE",
      minimumSelections: 0,
      maximumSelections: 3,
      displayOrder: 0,
      active: false,
      expectedVersion: group.version,
    });

    const [after] = (await itemsOf()).filter((row) => row.menuItemId === item.id);

    expect(after!.modifierGroups).toEqual([]);
  });

  it("is limited to the organization", async () => {
    const { item } = await sellableItem(database(), scenario.admin);
    const foreign = await getOperationalMenu(database(), scenario.other);

    expect(
      foreign.menus.flatMap((menu) => menu.categories.flatMap((category) => category.items)).map((row) => row.menuItemId),
    ).not.toContain(item.id);
  });

  it("does not leak recipe, cost, audit or version data", async () => {
    const { item } = await sellableItem(database(), scenario.admin);
    const modifier = await modifierFixture(database(), scenario.admin);

    await attachGroupWith(database(), scenario.admin, item.id, "OPTIONAL_MULTIPLE", [modifier.id]);

    const serialized = JSON.stringify(await read());

    for (const forbidden of [
      "recipe",
      "revision",
      "yield",
      "cost",
      "version",
      "createdBy",
      "created_by",
      "organizationId",
      "employee",
      "compensation",
      "inventory",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("requires menu.view", async () => {
    await expect(getOperationalMenu(database(), scenario.outsider)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
