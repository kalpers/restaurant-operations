import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { quantity } from "../helpers/numeric";
import { createdAt, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { inventoryItems } from "./inventory";
import { menuItems, modifiers } from "./menu";
import { organizations } from "./organization";
import { recipeVersions, unitsOfMeasure } from "./recipes";

// The links from the Recipe and Menu domains to Inventory Item identity. These are
// configuration: saving them never moves stock. They live apart from both schemas so neither
// imports the other.

/**
 * What one recipe revision requires, per batch of its yield. Editable only while the
 * revision is a DRAFT: a trigger refuses any change to the rows of a published revision.
 */
export const recipeVersionIngredients = pgTable(
  "recipe_version_ingredients",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recipeVersionId: uuid("recipe_version_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    quantity: quantity("quantity").notNull(),
    unitOfMeasureId: uuid("unit_of_measure_id").notNull(),
    preparationNote: text("preparation_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "recipe_version_ingredients_version_fk",
      columns: [table.recipeVersionId],
      foreignColumns: [recipeVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "recipe_version_ingredients_unit_fk",
      columns: [table.unitOfMeasureId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    unique("recipe_version_ingredients_version_item_unique").on(
      table.recipeVersionId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "recipe_version_ingredients_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    check("recipe_version_ingredients_quantity_positive", sql`${table.quantity} > 0`),
    index("recipe_version_ingredients_item_idx").on(table.inventoryItemId),
  ],
);

/**
 * How a modifier changes one Menu Item's recipe requirements. ADD has a positive quantity;
 * REMOVE has none and drops the requirement; ADJUST has a signed, non-zero quantity.
 */
export const modifierInventoryEffects = pgTable(
  "modifier_inventory_effects",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    modifierId: uuid("modifier_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    effectType: text("effect_type").notNull(),
    quantity: quantity("quantity"),
    unitOfMeasureId: uuid("unit_of_measure_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "modifier_inventory_effects_unit_fk",
      columns: [table.unitOfMeasureId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    unique("modifier_inventory_effects_modifier_menu_item_item_unique").on(
      table.modifierId,
      table.menuItemId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "modifier_inventory_effects_modifier_org_fk",
      columns: [table.modifierId, table.organizationId],
      foreignColumns: [modifiers.id, modifiers.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "modifier_inventory_effects_menu_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "modifier_inventory_effects_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    check(
      "modifier_inventory_effects_shape",
      sql`(${table.effectType} = 'ADD' AND ${table.quantity} > 0 AND ${table.unitOfMeasureId} IS NOT NULL)
        OR (${table.effectType} = 'REMOVE' AND ${table.quantity} IS NULL AND ${table.unitOfMeasureId} IS NULL)
        OR (${table.effectType} = 'ADJUST' AND ${table.quantity} <> 0 AND ${table.unitOfMeasureId} IS NOT NULL)`,
    ),
    index("modifier_inventory_effects_menu_item_idx").on(table.menuItemId),
  ],
);
