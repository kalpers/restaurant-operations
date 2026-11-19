import { sql, type SQL } from "drizzle-orm";
import { check, foreignKey, pgTable, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { quantity } from "../helpers/numeric";
import { createdAt, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { inventoryItems } from "./inventory";
import { menuItems } from "./menu";
import { organizations } from "./organization";

// Phase 28 nutrition (policies 11 and 12), owned by Recipes, beside the allergen tables, so
// `inventory_items` stays Inventory's. Figures are NUMERIC(14,4) and nullable: null means "no
// data", which makes an item's figure incomplete, never zero. A label is worked out on read
// from the current recipe and the chosen modifiers; nothing is snapshotted at SEND.

export { NUTRITION_FIGURES, type NutritionFigure } from "../../shared/nutrition/figures";

function figures() {
  return {
    calories: quantity("calories"),
    fatG: quantity("fat_g"),
    saturatedFatG: quantity("saturated_fat_g"),
    carbohydrateG: quantity("carbohydrate_g"),
    sugarsG: quantity("sugars_g"),
    fibreG: quantity("fibre_g"),
    proteinG: quantity("protein_g"),
    sodiumMg: quantity("sodium_mg"),
  };
}

function nonNegative(columns: SQL[]) {
  return sql.join(
    columns.map((column) => sql`(${column} IS NULL OR ${column} >= 0)`),
    sql` AND `,
  );
}

/** Nutrition of one ingredient per `basis_quantity` of its base unit (e.g. per 100 G, per 1 EACH). */
export const inventoryItemNutrition = pgTable(
  "inventory_item_nutrition",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    basisQuantity: quantity("basis_quantity").notNull(),
    ...figures(),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "inventory_item_nutrition_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    unique("inventory_item_nutrition_item_unique").on(table.inventoryItemId),
    check("inventory_item_nutrition_basis_positive", sql`${table.basisQuantity} > 0`),
    check(
      "inventory_item_nutrition_figures_non_negative",
      nonNegative([
        sql`${table.calories}`,
        sql`${table.fatG}`,
        sql`${table.saturatedFatG}`,
        sql`${table.carbohydrateG}`,
        sql`${table.sugarsG}`,
        sql`${table.fibreG}`,
        sql`${table.proteinG}`,
        sql`${table.sodiumMg}`,
      ]),
    ),
  ],
);

/** Declared nutrition per portion of a menu item; replaces the calculation (bought-in items). */
export const menuItemNutrition = pgTable(
  "menu_item_nutrition",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    menuItemId: uuid("menu_item_id").notNull(),
    ...figures(),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_nutrition_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    unique("menu_item_nutrition_item_unique").on(table.menuItemId),
    check(
      "menu_item_nutrition_figures_non_negative",
      nonNegative([
        sql`${table.calories}`,
        sql`${table.fatG}`,
        sql`${table.saturatedFatG}`,
        sql`${table.carbohydrateG}`,
        sql`${table.sugarsG}`,
        sql`${table.fibreG}`,
        sql`${table.proteinG}`,
        sql`${table.sodiumMg}`,
      ]),
    ),
  ],
);
