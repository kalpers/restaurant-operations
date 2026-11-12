import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, numeric, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations, organizations } from "./organization";

// Phase 17 tax configuration, owned by the Menu domain. Taxability is explicit: a Menu
// Item is taxed only through the Tax Category assigned to it, never inferred from its type
// or category. Rates are effective-dated per Category and Location, half-open
// `[effective_from, effective_to)`; a change closes the open row and inserts a new one.
// The no-overlap rule is an exclusion constraint in the custom migration.

/** A tax rate percentage, e.g. "8.2500". Not money: `NUMERIC(7,4)`, 0 to 100. */
export function taxRate(name: string) {
  return numeric(name, { precision: 7, scale: 4, mode: "string" });
}

export const taxCategories = pgTable(
  "tax_categories",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("tax_categories_organization_id_code_unique").on(table.organizationId, table.code),
    unique("tax_categories_id_organization_id_unique").on(table.id, table.organizationId),
    check("tax_categories_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("tax_categories_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    taxCategoryId: uuid("tax_category_id").notNull(),
    locationId: uuid("location_id").notNull(),
    ratePercent: taxRate("rate_percent").notNull(),
    /**
     * Phase 20 (policy 15, D13): the menu price already includes this tax. Set with the rate,
     * so it is effective-dated with it; snapshotted on each item at SEND.
     */
    priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
    effectiveFrom: timestamptz("effective_from").notNull(),
    effectiveTo: timestamptz("effective_to"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "tax_rates_category_org_fk",
      columns: [table.taxCategoryId, table.organizationId],
      foreignColumns: [taxCategories.id, taxCategories.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "tax_rates_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check("tax_rates_rate_range", sql`${table.ratePercent} >= 0 AND ${table.ratePercent} <= 100`),
    check(
      "tax_rates_interval_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index("tax_rates_category_location_from_idx").on(
      table.taxCategoryId,
      table.locationId,
      table.effectiveFrom,
    ),
  ],
);
