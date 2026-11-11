import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations, organizations } from "./organization";
import { taxCategories } from "./tax";

// Menu Items are organization-scoped catalog records. A category is reached through a
// placement, never a column on the item. Prices are effective-dated rows that are closed,
// not edited. Overlap rules (prices, menu availability) are exclusion constraints added
// in the custom migration, because Drizzle's schema language can't express them.
// Same-organization ownership is enforced by composite foreign keys on (id, organization_id).

const MENU_ITEM_TYPES = "'FOOD', 'BEVERAGE', 'ALCOHOL', 'OTHER'";
const SELECTION_TYPES =
  "'OPTIONAL_SINGLE', 'REQUIRED_SINGLE', 'OPTIONAL_MULTIPLE', 'REQUIRED_MULTIPLE'";
const PREPARATION_EFFECTS =
  "'NONE', 'INSTRUCTION', 'ADD_COMPONENT', 'REMOVE_COMPONENT', 'ADJUST_COMPONENT'";

function organizationColumn() {
  return uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" });
}

export const menus = pgTable(
  "menus",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("menus_organization_id_code_unique").on(table.organizationId, table.code),
    unique("menus_id_organization_id_unique").on(table.id, table.organizationId),
    check("menus_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("menus_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/** A menu is offered at a location only where this row is active. */
export const menuLocations = pgTable(
  "menu_locations",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    menuId: uuid("menu_id").notNull(),
    locationId: uuid("location_id").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("menu_locations_menu_id_location_id_unique").on(table.menuId, table.locationId),
    foreignKey({
      name: "menu_locations_menu_org_fk",
      columns: [table.menuId, table.organizationId],
      foreignColumns: [menus.id, menus.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_locations_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    index("menu_locations_location_id_idx").on(table.locationId),
  ],
);

/**
 * Effective windows for a menu at a location, half-open `[effective_from, effective_to)`.
 * A menu/location pair with no windows is offered whenever its `menu_locations` row is
 * active; once it has windows, it is offered only inside one.
 */
export const menuAvailability = pgTable(
  "menu_availability",
  {
    id: uuidPrimaryKey(),
    menuId: uuid("menu_id").notNull(),
    locationId: uuid("location_id").notNull(),
    effectiveFrom: timestamptz("effective_from").notNull(),
    effectiveTo: timestamptz("effective_to"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "menu_availability_menu_location_fk",
      columns: [table.menuId, table.locationId],
      foreignColumns: [menuLocations.menuId, menuLocations.locationId],
    }).onDelete("restrict"),
    check(
      "menu_availability_interval_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index("menu_availability_menu_id_location_id_idx").on(table.menuId, table.locationId),
  ],
);

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("menu_categories_organization_id_code_unique").on(
      table.organizationId,
      table.code,
    ),
    unique("menu_categories_id_organization_id_unique").on(table.id, table.organizationId),
    check("menu_categories_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("menu_categories_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/** `active` is catalog membership; `available` is whether it can be sold right now. */
export const menuItems = pgTable(
  "menu_items",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    shortName: text("short_name"),
    itemType: text("item_type").notNull(),
    active: activeColumn(),
    available: boolean("available").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    /** Phase 17: explicit taxability. Null means no Tax Category is assigned. */
    taxCategoryId: uuid("tax_category_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "menu_items_tax_category_org_fk",
      columns: [table.taxCategoryId, table.organizationId],
      foreignColumns: [taxCategories.id, taxCategories.organizationId],
    }).onDelete("restrict"),
    unique("menu_items_organization_id_code_unique").on(table.organizationId, table.code),
    unique("menu_items_id_organization_id_unique").on(table.id, table.organizationId),
    check("menu_items_item_type_valid", sql`${table.itemType} IN (${sql.raw(MENU_ITEM_TYPES)})`),
    check("menu_items_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("menu_items_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/** One item in one category of one menu. An item may have many placements. */
export const menuItemPlacements = pgTable(
  "menu_item_placements",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    menuId: uuid("menu_id").notNull(),
    menuCategoryId: uuid("menu_category_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("menu_item_placements_menu_category_item_unique").on(
      table.menuId,
      table.menuCategoryId,
      table.menuItemId,
    ),
    foreignKey({
      name: "menu_item_placements_menu_org_fk",
      columns: [table.menuId, table.organizationId],
      foreignColumns: [menus.id, menus.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_placements_category_org_fk",
      columns: [table.menuCategoryId, table.organizationId],
      foreignColumns: [menuCategories.id, menuCategories.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_placements_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    index("menu_item_placements_menu_item_id_idx").on(table.menuItemId),
  ],
);

/**
 * Effective-dated selling price, half-open `[effective_from, effective_to)`. A null
 * `location_id` is the organization default; a location row wins over it. Rows are never
 * edited to change a price: the open row is closed and a new one inserted.
 */
export const menuItemPrices = pgTable(
  "menu_item_prices",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    menuItemId: uuid("menu_item_id").notNull(),
    locationId: uuid("location_id"),
    price: money("price").notNull(),
    effectiveFrom: timestamptz("effective_from").notNull(),
    effectiveTo: timestamptz("effective_to"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_prices_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_prices_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check("menu_item_prices_price_non_negative", sql`${table.price} >= 0`),
    check(
      "menu_item_prices_interval_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index("menu_item_prices_item_location_from_idx").on(
      table.menuItemId,
      table.locationId,
      table.effectiveFrom,
    ),
  ],
);

export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    selectionType: text("selection_type").notNull(),
    minimumSelections: integer("minimum_selections").notNull().default(0),
    maximumSelections: integer("maximum_selections"),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("modifier_groups_organization_id_code_unique").on(
      table.organizationId,
      table.code,
    ),
    unique("modifier_groups_id_organization_id_unique").on(table.id, table.organizationId),
    check(
      "modifier_groups_selection_type_valid",
      sql`${table.selectionType} IN (${sql.raw(SELECTION_TYPES)})`,
    ),
    check("modifier_groups_minimum_non_negative", sql`${table.minimumSelections} >= 0`),
    check(
      "modifier_groups_maximum_valid",
      sql`${table.maximumSelections} IS NULL OR ${table.maximumSelections} >= ${table.minimumSelections}`,
    ),
    check(
      "modifier_groups_type_matches_counts",
      sql`(${table.selectionType} = 'OPTIONAL_SINGLE' AND ${table.minimumSelections} = 0 AND ${table.maximumSelections} = 1)
        OR (${table.selectionType} = 'REQUIRED_SINGLE' AND ${table.minimumSelections} = 1 AND ${table.maximumSelections} = 1)
        OR (${table.selectionType} = 'OPTIONAL_MULTIPLE' AND ${table.minimumSelections} = 0 AND (${table.maximumSelections} IS NULL OR ${table.maximumSelections} >= 1))
        OR (${table.selectionType} = 'REQUIRED_MULTIPLE' AND ${table.minimumSelections} >= 1)`,
    ),
    check("modifier_groups_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("modifier_groups_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/**
 * `preparation_effect_type` says how the modifier changes preparation, for kitchen
 * display. Free text never touches inventory; ingredient effects are a typed contract
 * that Phase 8 persists.
 */
export const modifiers = pgTable(
  "modifiers",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    priceAdjustment: money("price_adjustment").notNull().default("0.00"),
    preparationEffectType: text("preparation_effect_type").notNull().default("NONE"),
    preparationInstruction: text("preparation_instruction"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("modifiers_organization_id_code_unique").on(table.organizationId, table.code),
    unique("modifiers_id_organization_id_unique").on(table.id, table.organizationId),
    check(
      "modifiers_preparation_effect_valid",
      sql`${table.preparationEffectType} IN (${sql.raw(PREPARATION_EFFECTS)})`,
    ),
    check(
      "modifiers_instruction_required",
      sql`${table.preparationEffectType} <> 'INSTRUCTION' OR length(trim(coalesce(${table.preparationInstruction}, ''))) > 0`,
    ),
    check("modifiers_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("modifiers_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const modifierGroupModifiers = pgTable(
  "modifier_group_modifiers",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    modifierGroupId: uuid("modifier_group_id").notNull(),
    modifierId: uuid("modifier_id").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("modifier_group_modifiers_group_modifier_unique").on(
      table.modifierGroupId,
      table.modifierId,
    ),
    foreignKey({
      name: "modifier_group_modifiers_group_org_fk",
      columns: [table.modifierGroupId, table.organizationId],
      foreignColumns: [modifierGroups.id, modifierGroups.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "modifier_group_modifiers_modifier_org_fk",
      columns: [table.modifierId, table.organizationId],
      foreignColumns: [modifiers.id, modifiers.organizationId],
    }).onDelete("restrict"),
    index("modifier_group_modifiers_modifier_id_idx").on(table.modifierId),
  ],
);

/**
 * Attaches a group to an item. Overrides apply only when set: `required_override` true
 * means at least one selection, false means none required; explicit minimum/maximum
 * overrides win over it. The effective values are resolved in one place in the service.
 */
export const menuItemModifierGroups = pgTable(
  "menu_item_modifier_groups",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    menuItemId: uuid("menu_item_id").notNull(),
    modifierGroupId: uuid("modifier_group_id").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    requiredOverride: boolean("required_override"),
    minimumOverride: integer("minimum_override"),
    maximumOverride: integer("maximum_override"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("menu_item_modifier_groups_item_group_unique").on(
      table.menuItemId,
      table.modifierGroupId,
    ),
    foreignKey({
      name: "menu_item_modifier_groups_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_modifier_groups_group_org_fk",
      columns: [table.modifierGroupId, table.organizationId],
      foreignColumns: [modifierGroups.id, modifierGroups.organizationId],
    }).onDelete("restrict"),
    check(
      "menu_item_modifier_groups_minimum_override_valid",
      sql`${table.minimumOverride} IS NULL OR ${table.minimumOverride} >= 0`,
    ),
    check(
      "menu_item_modifier_groups_maximum_override_valid",
      sql`${table.maximumOverride} IS NULL OR ${table.maximumOverride} >= GREATEST(coalesce(${table.minimumOverride}, 0), 1)`,
    ),
    index("menu_item_modifier_groups_group_id_idx").on(table.modifierGroupId),
  ],
);

/** Preparation routing configuration only. No tickets exist until Phase 10. */
export const prepStations = pgTable(
  "prep_stations",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    stationType: text("station_type").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("prep_stations_location_id_code_unique").on(table.locationId, table.code),
    unique("prep_stations_id_location_id_unique").on(table.id, table.locationId),
    check(
      "prep_stations_station_type_valid",
      sql`${table.stationType} IN ('KITCHEN', 'BAR', 'EXPO')`,
    ),
    check("prep_stations_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("prep_stations_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/** Where an item is prepared at a location. Several stations allow composite fulfillment. */
export const menuItemPrepRouting = pgTable(
  "menu_item_prep_routing",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    menuItemId: uuid("menu_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    prepStationId: uuid("prep_station_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("menu_item_prep_routing_item_location_station_unique").on(
      table.menuItemId,
      table.locationId,
      table.prepStationId,
    ),
    foreignKey({
      name: "menu_item_prep_routing_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_prep_routing_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_prep_routing_station_location_fk",
      columns: [table.prepStationId, table.locationId],
      foreignColumns: [prepStations.id, prepStations.locationId],
    }).onDelete("restrict"),
    index("menu_item_prep_routing_station_idx").on(table.prepStationId),
  ],
);
