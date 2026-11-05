import {
  locations,
  locationSettings,
  organizations,
  restaurantAreas,
} from "../schema";
import type { Seed } from "./run-seeds";

function firstRow<Row>(rows: readonly Row[]): Row {
  const [row] = rows;

  if (row === undefined) {
    throw new Error("Seed insert returned no row.");
  }

  return row;
}

/**
 * One organization, its main location, settings and areas. Settings come from the
 * column defaults: 4:00 AM cutoff, 90-minute turns and reservations, 15-minute wait
 * quote, all capabilities enabled.
 */
export const organizationFoundationSeed: Seed = {
  key: "organization.initial",
  run: async (transaction) => {
    const organization = firstRow(
      await transaction
        .insert(organizations)
        .values({
          name: "Restaurant Operations POC",
          defaultTimezone: "America/Detroit",
          defaultCurrency: "USD",
        })
        .returning({ id: organizations.id }),
    );

    const location = firstRow(
      await transaction
        .insert(locations)
        .values({
          organizationId: organization.id,
          name: "Main Restaurant",
          locationCode: "MAIN",
          timezone: "America/Detroit",
        })
        .returning({ id: locations.id }),
    );

    await transaction.insert(locationSettings).values({ locationId: location.id });

    await transaction.insert(restaurantAreas).values([
      {
        locationId: location.id,
        code: "DINING_ROOM",
        name: "Dining Room",
        areaType: "DINING",
        displayOrder: 1,
      },
      {
        locationId: location.id,
        code: "BAR",
        name: "Bar",
        areaType: "BAR",
        displayOrder: 2,
      },
      {
        locationId: location.id,
        code: "TAKEOUT",
        name: "Takeout",
        areaType: "TAKEOUT",
        displayOrder: 3,
      },
    ]);
  },
};
