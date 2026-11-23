import { eq } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  PIZZA_CATEGORIES,
  PIZZA_RESTAURANT_NAME,
  PIZZA_SALES_TAX,
  PIZZA_SECTIONS,
  PIZZA_STATIONS,
  PIZZA_TABLES,
} from "../../src/db/demo/pizza/restaurant";
import { locations, restaurantAreas } from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { createCategory, listCategories } from "../../src/modules/menu/services/catalog-service";
import { createStation, listStations } from "../../src/modules/menu/services/prep-station-service";
import {
  changeTaxRate,
  createTaxCategory,
  getLocationTaxSetting,
  listTaxCategories,
  listTaxRates,
  setLocationTaxEnabled,
} from "../../src/modules/menu/services/tax-service";
import { updateLocation } from "../../src/modules/organization/services/organization-service";
import { createSection, listSections, setSectionTables, updateSection } from "../../src/modules/restaurant/services/section-service";
import { createTable, listTablesForConfiguration } from "../../src/modules/restaurant/services/table-service";

import { need } from "./helpers";

export type RestaurantSummary = { renamed: boolean; tables: number; sections: number; stations: number; categories: number; taxCategoryId: string; taxTurnedOn: boolean };

/**
 * The pizza restaurant's setup at MAIN, through the services a manager would use. Run with the
 * clock moved back to before the history, so the 6% rate is in effect for every past check.
 * Each part skips what already exists, so a rerun adds nothing and hand edits survive.
 */
export async function seedPizzaRestaurant(database: Database, owner: Actor): Promise<RestaurantSummary> {
  const summary: RestaurantSummary = { renamed: false, tables: 0, sections: 0, stations: 0, categories: 0, taxCategoryId: "", taxTurnedOn: false };

  // The location's name, while it still has the baseline one.
  const [location] = await database.select().from(locations).where(eq(locations.id, owner.locationId));

  if (location && location.name === "Main Restaurant") {
    await updateLocation(database, location.id, {
      name: PIZZA_RESTAURANT_NAME,
      addressLine1: location.addressLine1,
      addressLine2: location.addressLine2,
      city: location.city,
      state: location.state,
      postalCode: location.postalCode,
      country: location.country,
      phone: location.phone,
      email: location.email,
      timezone: location.timezone,
      expectedVersion: location.version,
    });
    summary.renamed = true;
  }

  // Tables.
  const areas = new Map(
    (await database.select({ id: restaurantAreas.id, code: restaurantAreas.code }).from(restaurantAreas).where(eq(restaurantAreas.locationId, owner.locationId))).map(
      (row) => [row.code, row.id],
    ),
  );
  const existingTables = new Set((await listTablesForConfiguration(database, owner)).map((table) => table.tableNumber));

  for (const table of PIZZA_TABLES) {
    if (existingTables.has(table.tableNumber)) {
      continue;
    }

    await createTable(database, owner, {
      restaurantAreaId: need(areas, table.areaCode, "area"),
      tableNumber: table.tableNumber,
      name: null,
      capacity: table.capacity,
      minimumCapacity: table.minimumCapacity,
      sortOrder: table.sortOrder,
    });
    summary.tables += 1;
  }

  // Sections: created where missing and given their tables while they have none.
  const tableIds = new Map((await listTablesForConfiguration(database, owner)).map((table) => [table.tableNumber, table.id]));

  for (const section of PIZZA_SECTIONS) {
    let existing = (await listSections(database, owner)).find((row) => row.code === section.code);

    if (!existing) {
      await createSection(database, owner, { code: section.code, name: section.name, restaurantAreaId: need(areas, section.areaCode, "area") });
      existing = (await listSections(database, owner)).find((row) => row.code === section.code)!;
      summary.sections += 1;
    } else if (existing.name !== section.name && section.code === "DINING_A" && existing.name === "Dining A") {
      await updateSection(database, owner, existing.id, {
        name: section.name,
        restaurantAreaId: existing.restaurantAreaId,
        active: existing.active,
        expectedVersion: existing.version,
      });
      existing = (await listSections(database, owner)).find((row) => row.code === section.code)!;
    }

    const wanted = section.tables.map((number) => need(tableIds, number, "table"));
    const current = new Set(existing.tables.map((table) => table.tableId));

    if (wanted.some((id) => !current.has(id))) {
      await setSectionTables(database, owner, existing.id, { tableIds: [...new Set([...current, ...wanted])], expectedVersion: existing.version });
    }
  }

  // Prep stations and categories.
  const stations = new Set((await listStations(database, owner)).map((row) => row.code));

  for (const station of PIZZA_STATIONS) {
    if (!stations.has(station.code)) {
      await createStation(database, owner, station);
      summary.stations += 1;
    }
  }

  const categories = new Set((await listCategories(database, owner)).map((row) => row.code));

  for (const category of PIZZA_CATEGORIES) {
    if (!categories.has(category.code)) {
      await createCategory(database, owner, { ...category, description: null });
      summary.categories += 1;
    }
  }

  // The one sales tax, added on top, and tax turned on at MAIN.
  let tax = (await listTaxCategories(database, owner)).find((row) => row.code === PIZZA_SALES_TAX.code);

  if (!tax) {
    tax = await createTaxCategory(database, owner, { code: PIZZA_SALES_TAX.code, name: PIZZA_SALES_TAX.name, description: PIZZA_SALES_TAX.description });
  }

  if (!(await listTaxRates(database, owner)).some((rate) => rate.taxCategoryId === tax!.id)) {
    await changeTaxRate(database, owner, {
      taxCategoryId: tax.id,
      ratePercent: PIZZA_SALES_TAX.ratePercent,
      priceIncludesTax: PIZZA_SALES_TAX.priceIncludesTax,
      effectiveFrom: null,
      expectedCurrentRateId: null,
    });
  }

  summary.taxCategoryId = tax.id;

  const setting = await getLocationTaxSetting(database, owner);

  if (!setting.taxEnabled) {
    await setLocationTaxEnabled(database, owner, { enabled: true, expectedVersion: setting.version });
    summary.taxTurnedOn = true;
  }

  return summary;
}
