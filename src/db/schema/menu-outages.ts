import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { menuItems, modifiers } from "./menu";
import { locations, organizations } from "./organization";

// Phase 19 per-location 86 list, owned by Menu (approved policies A2 and A5). `menu_items.available`
// stays the organization-wide "can be sold" flag; an outage takes one item off sale at one
// location. A RESTORED outage is frozen by a trigger (migration 0038). A stock override lets a
// manager keep selling an item that auto-86 would hide, for one business date only.

export const MENU_ITEM_OUTAGE_STATUSES = ["ACTIVE", "RESTORED"] as const;

export const menuItemOutages = pgTable(
  "menu_item_outages",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    reason: text("reason").notNull(),
    markedOutAt: timestamptz("marked_out_at").notNull(),
    markedOutByUserId: uuid("marked_out_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * Phase 20 scheduled 86 (policy 4): in effect while `starts_at <= now < ends_at` (no end:
     * until restored). Migration 0040 backfills `starts_at` from `marked_out_at`.
     */
    startsAt: timestamptz("starts_at").notNull().defaultNow(),
    endsAt: timestamptz("ends_at"),
    restoredAt: timestamptz("restored_at"),
    restoredByUserId: uuid("restored_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_outages_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_outages_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    // Phase 20: the one-ACTIVE partial unique index became an exclusion constraint on the
    // [starts_at, ends_at) window (migration 0040), so scheduled 86es may follow each other.
    check(
      "menu_item_outages_window_valid",
      sql`${table.startsAt} >= ${table.markedOutAt} AND (${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt})`,
    ),
    check("menu_item_outages_status_valid", sql`${table.status} IN ('ACTIVE', 'RESTORED')`),
    check("menu_item_outages_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
    check(
      "menu_item_outages_restore_consistent",
      sql`(${table.status} = 'ACTIVE' AND ${table.restoredAt} IS NULL AND ${table.restoredByUserId} IS NULL) OR (${table.status} = 'RESTORED' AND ${table.restoredAt} IS NOT NULL AND ${table.restoredByUserId} IS NOT NULL AND ${table.restoredAt} >= ${table.markedOutAt})`,
    ),
    index("menu_item_outages_location_marked_idx").on(table.locationId, table.markedOutAt),
  ],
);

export const menuItemStockOverrides = pgTable(
  "menu_item_stock_overrides",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    businessDate: businessDate().notNull(),
    reason: text("reason").notNull(),
    setAt: timestamptz("set_at").notNull(),
    setByUserId: uuid("set_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clearedAt: timestamptz("cleared_at"),
    clearedByUserId: uuid("cleared_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_stock_overrides_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_stock_overrides_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    uniqueIndex("menu_item_stock_overrides_one_open")
      .on(table.locationId, table.menuItemId, table.businessDate)
      .where(sql`${table.clearedAt} IS NULL`),
    check("menu_item_stock_overrides_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
    check(
      "menu_item_stock_overrides_clear_consistent",
      sql`(${table.clearedAt} IS NULL) = (${table.clearedByUserId} IS NULL) AND (${table.clearedAt} IS NULL OR ${table.clearedAt} >= ${table.setAt})`,
    ),
    index("menu_item_stock_overrides_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

/**
 * Phase 20 modifier 86 (policies 3 and 4): the same lifecycle as an item outage. A modifier
 * 86'd here can't be chosen at this location; an item whose required group is left with
 * fewer choices than its minimum isn't sellable here. Guarded by migration 0040.
 */
export const modifierOutages = pgTable(
  "modifier_outages",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    modifierId: uuid("modifier_id").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    reason: text("reason").notNull(),
    markedOutAt: timestamptz("marked_out_at").notNull(),
    markedOutByUserId: uuid("marked_out_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startsAt: timestamptz("starts_at").notNull().defaultNow(),
    endsAt: timestamptz("ends_at"),
    restoredAt: timestamptz("restored_at"),
    restoredByUserId: uuid("restored_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "modifier_outages_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "modifier_outages_modifier_org_fk",
      columns: [table.modifierId, table.organizationId],
      foreignColumns: [modifiers.id, modifiers.organizationId],
    }).onDelete("restrict"),
    check("modifier_outages_status_valid", sql`${table.status} IN ('ACTIVE', 'RESTORED')`),
    check("modifier_outages_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
    check(
      "modifier_outages_restore_consistent",
      sql`(${table.status} = 'ACTIVE' AND ${table.restoredAt} IS NULL AND ${table.restoredByUserId} IS NULL) OR (${table.status} = 'RESTORED' AND ${table.restoredAt} IS NOT NULL AND ${table.restoredByUserId} IS NOT NULL AND ${table.restoredAt} >= ${table.markedOutAt})`,
    ),
    check(
      "modifier_outages_window_valid",
      sql`${table.startsAt} >= ${table.markedOutAt} AND (${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt})`,
    ),
    index("modifier_outages_location_marked_idx").on(table.locationId, table.markedOutAt),
  ],
);
