import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { inventoryItems } from "./inventory";
import { menuItems } from "./menu";
import { organizations } from "./organization";

// Phase 21 allergen labeling (policies 6, 9, 10), owned by Recipes. An item's label is worked
// out on read from these tags and its recipe, and snapshotted at SEND (`order_item_allergens`).
// Tags and declarations are configuration: they may be replaced, because sent items keep their
// own snapshot. The review mark says someone checked an ingredient's allergens, so an empty
// tag list is never read as "allergen free" (D9).

export const ALLERGEN_DECLARATION_KINDS = ["CONTAINS", "MAY_CONTAIN"] as const;

/** The organization's allergen list. Seeded with the nine major US allergens; deactivated, never deleted. */
export const allergens = pgTable(
  "allergens",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("allergens_organization_id_code_unique").on(table.organizationId, table.code),
    unique("allergens_id_organization_id_unique").on(table.id, table.organizationId),
    check("allergens_code_format", sql`${table.code} ~ '^[A-Z][A-Z0-9_]{0,39}$'`),
    check("allergens_name_valid", sql`length(trim(${table.name})) BETWEEN 1 AND 60`),
  ],
);

/** Which allergens an ingredient contains. */
export const inventoryItemAllergens = pgTable(
  "inventory_item_allergens",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    allergenId: uuid("allergen_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "inventory_item_allergens_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_item_allergens_allergen_org_fk",
      columns: [table.allergenId, table.organizationId],
      foreignColumns: [allergens.id, allergens.organizationId],
    }).onDelete("restrict"),
    unique("inventory_item_allergens_item_allergen_unique").on(table.inventoryItemId, table.allergenId),
  ],
);

/**
 * Who last checked an ingredient's allergens, and when. Kept in its own Recipes table so the
 * Inventory domain's `inventory_items` stays Inventory's (amendment 1). No row: not reviewed.
 */
export const ingredientAllergenReviews = pgTable(
  "ingredient_allergen_reviews",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    reviewedAt: timestamptz("reviewed_at").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "ingredient_allergen_reviews_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    unique("ingredient_allergen_reviews_item_unique").on(table.inventoryItemId),
  ],
);

/** Allergens a menu item declares by hand: CONTAINS (no recipe shows it) or MAY_CONTAIN (cross-contact). */
export const menuItemAllergens = pgTable(
  "menu_item_allergens",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    allergenId: uuid("allergen_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_allergens_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "menu_item_allergens_allergen_org_fk",
      columns: [table.allergenId, table.organizationId],
      foreignColumns: [allergens.id, allergens.organizationId],
    }).onDelete("restrict"),
    unique("menu_item_allergens_item_allergen_unique").on(table.menuItemId, table.allergenId),
    check("menu_item_allergens_kind_valid", sql`${table.kind} IN ('CONTAINS', 'MAY_CONTAIN')`),
    index("menu_item_allergens_allergen_idx").on(table.allergenId),
  ],
);

/**
 * Who last checked a menu item's declared allergens. Saving the declarations (even none) is a
 * review, so an item with no recipe, such as bottled water, can be labeled complete (amendment 2).
 */
export const menuItemAllergenReviews = pgTable(
  "menu_item_allergen_reviews",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    reviewedAt: timestamptz("reviewed_at").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "menu_item_allergen_reviews_item_org_fk",
      columns: [table.menuItemId, table.organizationId],
      foreignColumns: [menuItems.id, menuItems.organizationId],
    }).onDelete("restrict"),
    unique("menu_item_allergen_reviews_item_unique").on(table.menuItemId),
  ],
);
