import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { createdAt, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { menuItems } from "./menu";
import { locations, organizations } from "./organization";

// Phase 28 price periods ("happy hour"), owned by Menu (policies 2 to 5). A period is a set of
// local days and times at one location, optionally limited to order types, during which its
// items sell at a fixed price. Whether it applies is worked out at the SEND instant from these
// rows and the location's time zone; nothing is scheduled or stored per instant. Two active
// periods may not price one item for one order type at the same time (service check under the
// location lock). Deactivated, never deleted; sent items keep their own snapshots.

export const PRICE_PERIOD_ORDER_TYPES = ["DINE_IN", "BAR", "TAKEOUT"] as const;

export const pricePeriods = pgTable(
  "price_periods",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    /** Local weekdays the period starts on: 0 Sunday to 6 Saturday. */
    daysOfWeek: smallint("days_of_week").array().notNull(),
    /** Local wall-clock times. An end at or before the start crosses midnight. */
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    /** Null: every order type. */
    orderTypes: text("order_types").array(),
    /** Optional local dates (inclusive) of the day the period starts. */
    firstDate: date("first_date", { mode: "string" }),
    lastDate: date("last_date", { mode: "string" }),
    active: activeColumn(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "price_periods_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("price_periods_id_organization_id_unique").on(table.id, table.organizationId),
    check("price_periods_name_valid", sql`length(trim(${table.name})) BETWEEN 1 AND 60`),
    check(
      "price_periods_days_valid",
      sql`cardinality(${table.daysOfWeek}) BETWEEN 1 AND 7 AND ${table.daysOfWeek} <@ ARRAY[0,1,2,3,4,5,6]::smallint[]`,
    ),
    check("price_periods_times_differ", sql`${table.startTime} <> ${table.endTime}`),
    check(
      "price_periods_order_types_valid",
      sql`${table.orderTypes} IS NULL OR (cardinality(${table.orderTypes}) BETWEEN 1 AND 3 AND ${table.orderTypes} <@ ARRAY['DINE_IN','BAR','TAKEOUT']::text[])`,
    ),
    check(
      "price_periods_dates_ordered",
      sql`${table.firstDate} IS NULL OR ${table.lastDate} IS NULL OR ${table.lastDate} >= ${table.firstDate}`,
    ),
    index("price_periods_location_idx").on(table.locationId, table.active),
  ],
);

/** The fixed price one item sells at during a period. */
export const pricePeriodItems = pgTable(
  "price_period_items",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    pricePeriodId: uuid("price_period_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    price: money("price").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "price_period_items_period_org_fk",
      columns: [table.pricePeriodId, table.organizationId],
      foreignColumns: [pricePeriods.id, pricePeriods.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_period_items_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    unique("price_period_items_period_item_unique").on(table.pricePeriodId, table.menuItemId),
    check("price_period_items_price_non_negative", sql`${table.price} >= 0`),
    index("price_period_items_item_idx").on(table.menuItemId),
  ],
);
