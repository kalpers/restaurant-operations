import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { menuItemPlacements, menuItems } from "@/db/schema";
import {
  addAvailabilityWindow,
  closeAvailabilityWindow,
  createCategory,
  createItem,
  createPlacement,
  listCategories,
  listItems,
  listMenus,
  listPlacements,
  listUnplacedItems,
  setMenuLocation,
  updateCategory,
  updateItem,
  updatePlacement,
} from "@/modules/menu/services/catalog-service";
import {
  createStation,
  listItemRouting,
  listStations,
  setItemRouting,
  updateStation,
} from "@/modules/menu/services/prep-station-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { ABSENT_ID, actorWith } from "../../fixtures/employee-fixtures";
import {
  categoryFixture,
  createMenuScenario,
  itemFixture,
  menuFixture,
  uniqueCode,
  type MenuScenario,
} from "../../fixtures/menu-fixtures";

const database = () => getDatabase();

describe("menu configuration", () => {
  let scenario: MenuScenario;

  beforeEach(async () => {
    scenario = await createMenuScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe("categories", () => {
    it("creates a category and rejects a duplicate code in the organization", async () => {
      const code = uniqueCode("CAT");

      await createCategory(database(), scenario.admin, {
        code,
        name: "Burgers",
        description: null,
        displayOrder: 1,
      });

      await expect(
        createCategory(database(), scenario.admin, {
          code,
          name: "Again",
          description: null,
          displayOrder: 2,
        }),
      ).rejects.toMatchObject({ code: "CODE_TAKEN" });
    });

    it("allows the same code in another organization", async () => {
      const code = uniqueCode("CAT");
      const input = { code, name: "Beer", description: null, displayOrder: 0 };

      await createCategory(database(), scenario.admin, input);
      await expect(createCategory(database(), scenario.other, input)).resolves.toMatchObject({
        code,
      });
    });

    it("lists only the organization's own categories", async () => {
      const own = await categoryFixture(database(), scenario.admin);

      await categoryFixture(database(), scenario.other);

      const listed = await listCategories(database(), scenario.viewer);

      expect(listed.map((category) => category.id)).toEqual([own.id]);
    });

    it("deactivates rather than deletes, bumping the version", async () => {
      const category = await categoryFixture(database(), scenario.admin);
      const updated = await updateCategory(database(), scenario.admin, category.id, {
        name: category.name,
        description: null,
        displayOrder: 0,
        active: false,
        expectedVersion: category.version,
      });

      expect(updated.active).toBe(false);
      expect(updated.version).toBe(category.version + 1);
    });

    it("rejects a stale update with a concurrency conflict", async () => {
      const category = await categoryFixture(database(), scenario.admin);
      const edit = (name: string) =>
        updateCategory(database(), scenario.admin, category.id, {
          name,
          description: null,
          displayOrder: 0,
          active: true,
          expectedVersion: category.version,
        });

      await edit("First editor");
      await expect(edit("Second editor")).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("treats another organization's category as absent", async () => {
      const category = await categoryFixture(database(), scenario.admin);

      await expect(
        updateCategory(database(), scenario.other, category.id, {
          name: "Hijack",
          description: null,
          displayOrder: 0,
          active: true,
          expectedVersion: category.version,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("menu items", () => {
    it("has no category column: the category comes from placements", async () => {
      const item = await itemFixture(database(), scenario.admin);

      expect(Object.keys(item)).not.toContain("menuCategoryId");
    });

    it("keeps active (in the catalog) apart from available (sellable now)", async () => {
      const item = await itemFixture(database(), scenario.admin);

      expect(item).toMatchObject({ active: true, available: true });

      const eightySixed = await updateItem(database(), scenario.admin, item.id, {
        name: item.name,
        shortName: null,
        description: null,
        itemType: "FOOD",
        displayOrder: 0,
        active: true,
        available: false,
        expectedVersion: item.version,
      });

      expect(eightySixed).toMatchObject({ active: true, available: false });
    });

    it("rejects a duplicate code and an unknown item type", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(itemFixture(database(), scenario.admin, { code: item.code })).rejects.toMatchObject({
        code: "CODE_TAKEN",
      });
      await expect(
        createItem(database(), scenario.admin, {
          code: uniqueCode("ITEM"),
          name: "Odd",
          shortName: null,
          description: null,
          itemType: "NOT_A_TYPE" as never,
          displayOrder: 0,
        }),
      ).rejects.toThrow();
    });

    it("rejects a stale update", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const edit = (name: string) =>
        updateItem(database(), scenario.admin, item.id, {
          name,
          shortName: null,
          description: null,
          itemType: "FOOD",
          displayOrder: 0,
          active: true,
          available: true,
          expectedVersion: item.version,
        });

      await edit("A");
      await expect(edit("B")).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("lists items for viewers", async () => {
      const item = await itemFixture(database(), scenario.admin);

      expect((await listItems(database(), scenario.viewer)).map((row) => row.id)).toContain(
        item.id,
      );
    });
  });

  describe("menus and placements", () => {
    it("places one item in several menus and categories", async () => {
      const lunch = await menuFixture(database(), scenario.admin);
      const bar = await menuFixture(database(), scenario.admin);
      const burgers = await categoryFixture(database(), scenario.admin);
      const specials = await categoryFixture(database(), scenario.admin);
      const item = await itemFixture(database(), scenario.admin);

      for (const [menu, category] of [
        [lunch, burgers],
        [lunch, specials],
        [bar, burgers],
      ] as const) {
        await createPlacement(database(), scenario.admin, {
          menuId: menu.id,
          menuCategoryId: category.id,
          menuItemId: item.id,
          displayOrder: 0,
        });
      }

      const placements = await listPlacements(database(), scenario.viewer, {
        menuItemId: item.id,
      });

      expect(placements).toHaveLength(3);
    });

    it("rejects the same item twice in one category of one menu", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const category = await categoryFixture(database(), scenario.admin);
      const item = await itemFixture(database(), scenario.admin);
      const input = {
        menuId: menu.id,
        menuCategoryId: category.id,
        menuItemId: item.id,
        displayOrder: 0,
      };

      await createPlacement(database(), scenario.admin, input);
      await expect(createPlacement(database(), scenario.admin, input)).rejects.toMatchObject({
        code: "PLACEMENT_EXISTS",
      });
    });

    it("refuses a placement that mixes organizations", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const category = await categoryFixture(database(), scenario.admin);
      const foreignItem = await itemFixture(database(), scenario.other);
      const foreignCategory = await categoryFixture(database(), scenario.other);
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        createPlacement(database(), scenario.admin, {
          menuId: menu.id,
          menuCategoryId: category.id,
          menuItemId: foreignItem.id,
          displayOrder: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createPlacement(database(), scenario.admin, {
          menuId: menu.id,
          menuCategoryId: foreignCategory.id,
          menuItemId: item.id,
          displayOrder: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("enforces organization integrity in the database, not just the service", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const category = await categoryFixture(database(), scenario.admin);
      const foreignItem = await itemFixture(database(), scenario.other);

      await expect(
        database().insert(menuItemPlacements).values({
          organizationId: scenario.organizationId,
          menuId: menu.id,
          menuCategoryId: category.id,
          menuItemId: foreignItem.id,
        }),
      ).rejects.toThrow();
    });

    it("deactivates a placement and reports items with no active placement", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const category = await categoryFixture(database(), scenario.admin);
      const item = await itemFixture(database(), scenario.admin);
      const placement = await createPlacement(database(), scenario.admin, {
        menuId: menu.id,
        menuCategoryId: category.id,
        menuItemId: item.id,
        displayOrder: 0,
      });

      expect((await listUnplacedItems(database(), scenario.viewer)).map((row) => row.id)).not.toContain(item.id);

      await updatePlacement(database(), scenario.admin, placement.id, {
        displayOrder: 0,
        active: false,
        expectedVersion: placement.version,
      });

      expect((await listUnplacedItems(database(), scenario.viewer)).map((row) => row.id)).toContain(item.id);
    });

    it("never hard-deletes an item that has placements", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const category = await categoryFixture(database(), scenario.admin);
      const item = await itemFixture(database(), scenario.admin);

      await createPlacement(database(), scenario.admin, {
        menuId: menu.id,
        menuCategoryId: category.id,
        menuItemId: item.id,
        displayOrder: 0,
      });

      await expect(
        database().delete(menuItems).where(eq(menuItems.id, item.id)),
      ).rejects.toThrow();
    });

    it("offers a menu at a location and lists it", async () => {
      const menu = await menuFixture(database(), scenario.admin, { offerAtLocation: false });

      await setMenuLocation(database(), scenario.admin, menu.id, {
        locationId: scenario.locationB,
        active: true,
      });

      const [listed] = (await listMenus(database(), scenario.viewer)).filter(
        (row) => row.id === menu.id,
      );

      expect(listed?.locations).toEqual([
        { menuId: menu.id, locationId: scenario.locationB, active: true },
      ]);
    });

    it("refuses to offer a menu at another organization's location", async () => {
      const menu = await menuFixture(database(), scenario.admin, { offerAtLocation: false });

      await expect(
        setMenuLocation(database(), scenario.admin, menu.id, {
          locationId: scenario.otherScenario.locationA,
          active: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("menu availability windows", () => {
    const at = (iso: string) => new Date(iso);

    it("adds windows, rejects overlap, and allows adjacent windows", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const locationId = scenario.locationA;

      await addAvailabilityWindow(database(), scenario.admin, menu.id, {
        locationId,
        effectiveFrom: at("2030-01-01T00:00:00Z"),
        effectiveTo: at("2030-02-01T00:00:00Z"),
      });
      await expect(
        addAvailabilityWindow(database(), scenario.admin, menu.id, {
          locationId,
          effectiveFrom: at("2030-01-15T00:00:00Z"),
          effectiveTo: null,
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_OVERLAP" });
      await expect(
        addAvailabilityWindow(database(), scenario.admin, menu.id, {
          locationId,
          effectiveFrom: at("2030-02-01T00:00:00Z"),
          effectiveTo: null,
        }),
      ).resolves.toBeDefined();
    });

    it("rejects an empty window and a menu not offered at the location", async () => {
      const menu = await menuFixture(database(), scenario.admin);

      await expect(
        addAvailabilityWindow(database(), scenario.admin, menu.id, {
          locationId: scenario.locationA,
          effectiveFrom: at("2030-01-01T00:00:00Z"),
          effectiveTo: at("2030-01-01T00:00:00Z"),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INTERVAL" });
      await expect(
        addAvailabilityWindow(database(), scenario.admin, menu.id, {
          locationId: scenario.locationB,
          effectiveFrom: at("2030-01-01T00:00:00Z"),
          effectiveTo: null,
        }),
      ).rejects.toMatchObject({ code: "MENU_NOT_OFFERED_AT_LOCATION" });
    });

    it("closes an open window instead of deleting it", async () => {
      const menu = await menuFixture(database(), scenario.admin);
      const window = await addAvailabilityWindow(database(), scenario.admin, menu.id, {
        locationId: scenario.locationA,
        effectiveFrom: at("2024-01-01T00:00:00Z"),
        effectiveTo: null,
      });
      const now = at("2026-06-01T00:00:00Z");
      const closed = await closeAvailabilityWindow(database(), scenario.admin, window.id, now);

      expect(closed.effectiveTo).toEqual(now);
    });
  });

  describe("prep stations and routing", () => {
    const stationInput = () => ({
      code: uniqueCode("ST"),
      name: "Fixture station",
      stationType: "KITCHEN" as const,
      sortOrder: 0,
    });

    it("scopes stations to a location with a unique code per location", async () => {
      const input = stationInput();

      await createStation(database(), scenario.admin, input);
      await expect(createStation(database(), scenario.admin, input)).rejects.toMatchObject({
        code: "CODE_TAKEN",
      });

      const atB = await actorWith(
        database(),
        scenario,
        ["prep-stations.manage"],
        scenario.locationB,
      );

      await expect(createStation(database(), atB, input)).resolves.toBeDefined();
      expect((await listStations(database(), scenario.admin)).map((row) => row.code)).toContain(
        input.code,
      );
      expect((await listStations(database(), atB)).map((row) => row.code)).toContain(input.code);
    });

    it("routes an item to several stations and replaces the set", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const grill = await createStation(database(), scenario.admin, stationInput());
      const fry = await createStation(database(), scenario.admin, stationInput());

      const first = await setItemRouting(database(), scenario.admin, item.id, {
        prepStationIds: [grill.id, fry.id],
      });

      expect(first.map((row) => row.prepStationId)).toEqual([grill.id, fry.id]);

      const second = await setItemRouting(database(), scenario.admin, item.id, {
        prepStationIds: [fry.id],
      });

      expect(second.map((row) => row.prepStationId)).toEqual([fry.id]);
      // The dropped station is deactivated, not deleted.
      expect(await listItemRouting(database(), scenario.viewer, item.id)).toHaveLength(2);
    });

    it("refuses a station from another location or one that is inactive", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const station = await createStation(database(), scenario.admin, stationInput());
      const atB = await actorWith(database(), scenario, ["prep-stations.manage"], scenario.locationB);
      const stationAtB = await createStation(database(), atB, stationInput());

      await expect(
        setItemRouting(database(), scenario.admin, item.id, { prepStationIds: [stationAtB.id] }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await updateStation(database(), scenario.admin, station.id, {
        name: station.name,
        stationType: "KITCHEN",
        sortOrder: 0,
        active: false,
        expectedVersion: station.version,
      });
      await expect(
        setItemRouting(database(), scenario.admin, item.id, { prepStationIds: [station.id] }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a stale station update", async () => {
      const station = await createStation(database(), scenario.admin, stationInput());
      const edit = (name: string) =>
        updateStation(database(), scenario.admin, station.id, {
          name,
          stationType: "KITCHEN",
          sortOrder: 0,
          active: true,
          expectedVersion: station.version,
        });

      await edit("A");
      await expect(edit("B")).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("creates no kitchen tickets or fulfillment records (Phase 10 owns them)", async () => {
      const tables = await database().execute<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'` as never,
      );
      const names = (tables as unknown as { tablename: string }[]).map((row) => row.tablename);

      expect(names.filter((name) => /ticket|fulfillment/.test(name))).toEqual([]);
    });
  });

  describe("authorization", () => {
    it("refuses edits without menu.edit, even for a viewer", async () => {
      await expect(
        createCategory(database(), scenario.viewer, {
          code: uniqueCode("CAT"),
          name: "Nope",
          description: null,
          displayOrder: 0,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createItem(database(), scenario.viewer, {
          code: uniqueCode("ITEM"),
          name: "Nope",
          shortName: null,
          description: null,
          itemType: "FOOD",
          displayOrder: 0,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createStation(database(), scenario.viewer, {
          code: uniqueCode("ST"),
          name: "Nope",
          stationType: "BAR",
          sortOrder: 0,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("refuses reads without menu.view", async () => {
      await expect(listCategories(database(), scenario.outsider)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(listItems(database(), scenario.outsider)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(listStations(database(), scenario.outsider)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("looks like not-found for another organization's records", async () => {
      await expect(
        setItemRouting(database(), scenario.admin, ABSENT_ID, { prepStationIds: [] }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateItem(database(), scenario.other, (await itemFixture(database(), scenario.admin)).id, {
          name: "x",
          shortName: null,
          description: null,
          itemType: "FOOD",
          displayOrder: 0,
          active: true,
          available: true,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
