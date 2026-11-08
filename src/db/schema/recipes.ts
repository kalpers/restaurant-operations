import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { quantity } from "../helpers/numeric";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { menuItems } from "./menu";
import { organizations } from "./organization";

// Phase 7 holds Recipe identity, immutable revisions, yield and the unit vocabulary only.
// Ingredient rows (Recipe version -> Inventory Item, exact quantity) arrive in Phase 8,
// when Inventory Items exist. No ingredient catalog is created here.

/** Shared reference vocabulary. Never use an ambiguous "OZ": weight is OZ_WEIGHT, volume FL_OZ. */
export const unitsOfMeasure = pgTable(
  "units_of_measure",
  {
    id: uuidPrimaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    measurementType: text("measurement_type").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("units_of_measure_code_unique").on(table.code),
    unique("units_of_measure_id_measurement_type_unique").on(
      table.id,
      table.measurementType,
    ),
    check(
      "units_of_measure_measurement_type_valid",
      sql`${table.measurementType} IN ('COUNT', 'WEIGHT', 'VOLUME')`,
    ),
    check("units_of_measure_code_not_ambiguous", sql`${table.code} <> 'OZ'`),
  ],
);

/** Explicit, exact conversions between units of one measurement type. No density. */
export const unitConversions = pgTable(
  "unit_conversions",
  {
    id: uuidPrimaryKey(),
    fromUnitId: uuid("from_unit_id").notNull(),
    toUnitId: uuid("to_unit_id").notNull(),
    measurementType: text("measurement_type").notNull(),
    factor: numeric("factor", { precision: 14, scale: 6, mode: "string" }).notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("unit_conversions_from_to_unique").on(table.fromUnitId, table.toUnitId),
    foreignKey({
      name: "unit_conversions_from_unit_type_fk",
      columns: [table.fromUnitId, table.measurementType],
      foreignColumns: [unitsOfMeasure.id, unitsOfMeasure.measurementType],
    }).onDelete("restrict"),
    foreignKey({
      name: "unit_conversions_to_unit_type_fk",
      columns: [table.toUnitId, table.measurementType],
      foreignColumns: [unitsOfMeasure.id, unitsOfMeasure.measurementType],
    }).onDelete("restrict"),
    check("unit_conversions_factor_positive", sql`${table.factor} > 0`),
    check("unit_conversions_distinct_units", sql`${table.fromUnitId} <> ${table.toUnitId}`),
  ],
);

/** Durable recipe identity. A Menu Item may have one; a Menu Item doesn't need one. */
export const recipes = pgTable(
  "recipes",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    menuItemId: uuid("menu_item_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("recipes_organization_id_code_unique").on(table.organizationId, table.code),
    unique("recipes_id_organization_id_unique").on(table.id, table.organizationId),
    foreignKey({
      name: "recipes_menu_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    uniqueIndex("recipes_menu_item_id_unique")
      .on(table.menuItemId)
      .where(sql`${table.menuItemId} IS NOT NULL`),
    check("recipes_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("recipes_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/**
 * A revision of a recipe. Content (yield, notes, number) is frozen once the revision
 * leaves DRAFT: a trigger in the custom migration refuses edits. The effective interval is
 * half-open `[effective_from, effective_to)`; drafts have none. A RETIRED revision that
 * never took effect has an empty interval (`effective_to = effective_from`).
 */
export const recipeVersions = pgTable(
  "recipe_versions",
  {
    id: uuidPrimaryKey(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    status: text("status").notNull().default("DRAFT"),
    yieldQuantity: quantity("yield_quantity").notNull(),
    yieldUnitId: uuid("yield_unit_id").references(() => unitsOfMeasure.id, {
      onDelete: "restrict",
    }),
    preparationNotes: text("preparation_notes"),
    effectiveFrom: timestamptz("effective_from"),
    effectiveTo: timestamptz("effective_to"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    publishedAt: timestamptz("published_at"),
    retiredByUserId: uuid("retired_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    retiredAt: timestamptz("retired_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("recipe_versions_recipe_id_revision_number_unique").on(
      table.recipeId,
      table.revisionNumber,
    ),
    check("recipe_versions_revision_positive", sql`${table.revisionNumber} > 0`),
    check(
      "recipe_versions_status_valid",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'RETIRED')`,
    ),
    check("recipe_versions_yield_positive", sql`${table.yieldQuantity} > 0`),
    check(
      "recipe_versions_interval_matches_status",
      sql`(${table.status} = 'DRAFT' AND ${table.effectiveFrom} IS NULL AND ${table.effectiveTo} IS NULL)
        OR (${table.status} = 'PUBLISHED' AND ${table.effectiveFrom} IS NOT NULL AND (${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}))
        OR (${table.status} = 'RETIRED' AND ${table.effectiveFrom} IS NOT NULL AND ${table.effectiveTo} IS NOT NULL AND ${table.effectiveTo} >= ${table.effectiveFrom})`,
    ),
    index("recipe_versions_recipe_id_effective_from_idx").on(
      table.recipeId,
      table.effectiveFrom,
    ),
  ],
);
