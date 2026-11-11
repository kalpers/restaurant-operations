import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { createdAt, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";

export const organizations = pgTable(
  "organizations",
  {
    id: uuidPrimaryKey(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    phone: text("phone"),
    email: text("email"),
    defaultTimezone: text("default_timezone").notNull(),
    defaultCurrency: text("default_currency").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "organizations_default_currency_format",
      sql`${table.defaultCurrency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    locationCode: text("location_code").notNull(),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("US"),
    phone: text("phone"),
    email: text("email"),
    timezone: text("timezone").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("locations_organization_id_location_code_unique").on(
      table.organizationId,
      table.locationCode,
    ),
    // Lets Menu records prove a location belongs to the same organization.
    unique("locations_id_organization_id_unique").on(table.id, table.organizationId),
  ],
);

/** One row per location. The timezone lives on `locations`, not here. */
export const locationSettings = pgTable(
  "location_settings",
  {
    locationId: uuid("location_id")
      .primaryKey()
      .references(() => locations.id, { onDelete: "restrict" }),
    businessDayCutoff: time("business_day_cutoff").notNull().default("04:00:00"),
    defaultTableTurnMinutes: integer("default_table_turn_minutes")
      .notNull()
      .default(90),
    defaultReservationDurationMinutes: integer(
      "default_reservation_duration_minutes",
    )
      .notNull()
      .default(90),
    defaultWaitQuoteMinutes: integer("default_wait_quote_minutes")
      .notNull()
      .default(15),
    reservationPreHoldMinutes: integer("reservation_pre_hold_minutes")
      .notNull()
      .default(15),
    reservationPostGraceMinutes: integer("reservation_post_grace_minutes")
      .notNull()
      .default(15),
    allowWalkIns: boolean("allow_walk_ins").notNull().default(true),
    allowReservations: boolean("allow_reservations").notNull().default(true),
    allowTakeout: boolean("allow_takeout").notNull().default(true),
    inventoryEnabled: boolean("inventory_enabled").notNull().default(true),
    /** Approved policy: only CONSUME may take stock below zero, and only when true. */
    allowNegativeInventory: boolean("allow_negative_inventory").notNull().default(false),
    schedulingEnabled: boolean("scheduling_enabled").notNull().default(true),
    kitchenDisplayEnabled: boolean("kitchen_display_enabled")
      .notNull()
      .default(true),
    /** Phase 17: when false nothing is taxed. Changed only through the Tax endpoints. */
    taxEnabled: boolean("tax_enabled").notNull().default(false),
    /**
     * Phase 17: cash tenders and cash refunds need an OPEN drawer session. True for a new
     * location; the custom migration sets it false for locations that existed before.
     * Changed only through the drawer endpoints.
     */
    cashDrawerRequired: boolean("cash_drawer_required").notNull().default(true),
    /**
     * Phase 19: when true, an item whose current recipe can't cover one more portion from
     * on-hand stock isn't sellable here. Changed only through the menu stock-settings endpoint.
     */
    auto86FromStock: boolean("auto_86_from_stock").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "location_settings_minutes_positive",
      sql`${table.defaultTableTurnMinutes} > 0 AND ${table.defaultReservationDurationMinutes} > 0 AND ${table.defaultWaitQuoteMinutes} > 0`,
    ),
    check(
      "location_settings_reservation_hold_non_negative",
      sql`${table.reservationPreHoldMinutes} >= 0 AND ${table.reservationPostGraceMinutes} >= 0`,
    ),
  ],
);

export const restaurantAreas = pgTable(
  "restaurant_areas",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    areaType: text("area_type").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("restaurant_areas_location_id_code_unique").on(
      table.locationId,
      table.code,
    ),
    unique("restaurant_areas_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    check(
      "restaurant_areas_area_type_valid",
      sql`${table.areaType} IN ('DINING', 'BAR', 'TAKEOUT')`,
    ),
  ],
);
