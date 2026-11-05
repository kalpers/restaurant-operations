import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { Database } from "@/db";
import { activeColumn, uuidPrimaryKey } from "@/db/helpers/columns";
import { cost, money, quantity } from "@/db/helpers/numeric";
import {
  businessDate,
  createdAt,
  timestamptz,
  updatedAt,
} from "@/db/helpers/timestamps";
import { versionColumn } from "@/db/helpers/versioning";

// Test-only tables that exercise the database conventions. They are created by the
// tests below and are not part of src/db/schema, so they never reach a migration.

export const fixtureParents = pgTable("fixture_parents", {
  id: uuidPrimaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  active: activeColumn(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: versionColumn(),
});

export const fixtureChildren = pgTable(
  "fixture_children",
  {
    id: uuidPrimaryKey(),
    parentId: uuid("parent_id").references(() => fixtureParents.id),
    amount: money("amount"),
    unitCost: cost("unit_cost"),
    onHand: quantity("on_hand"),
    occurredAt: timestamptz("occurred_at"),
    businessDate: businessDate(),
  },
  (table) => [
    index("fixture_children_parent_id_idx").on(table.parentId),
    check("fixture_children_amount_not_negative", sql`${table.amount} >= 0`),
  ],
);

export async function createFixtureTables(database: Database): Promise<void> {
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS fixture_parents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL CONSTRAINT fixture_parents_code_unique UNIQUE,
      label TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      version INTEGER NOT NULL DEFAULT 1
    )
  `);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS fixture_children (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID CONSTRAINT fixture_children_parent_id_fk REFERENCES fixture_parents (id),
      amount NUMERIC(12,2) CONSTRAINT fixture_children_amount_not_negative CHECK (amount >= 0),
      unit_cost NUMERIC(14,4),
      on_hand NUMERIC(14,4),
      occurred_at TIMESTAMPTZ,
      business_date DATE
    )
  `);
}

export async function clearFixtureTables(database: Database): Promise<void> {
  await database.execute(sql`TRUNCATE fixture_children, fixture_parents, seed_runs`);
}

export async function dropFixtureTables(database: Database): Promise<void> {
  await database.execute(sql`DROP TABLE IF EXISTS fixture_children, fixture_parents`);
}
