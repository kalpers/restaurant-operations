import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt } from "../helpers/timestamps";
import { users } from "./auth";
import { organizations } from "./organization";

// Phase 34 (policies 12–13): a record of each free-text field a guest erase redacted, word by
// word. It names the table, row and column, never the text. Append-only (migration 0079). The
// freeze triggers of order items, kitchen ticket items and closed orders accept a redaction
// only with a row here written in the same transaction (`created_at = now()`).

/** The tables whose free text a guest erase may redact (amendment 6). */
export const REDACTABLE_TABLES = [
  "guest_parties",
  "reservations",
  "waitlist_entries",
  "table_sessions",
  "orders",
  "order_items",
  "kitchen_ticket_items",
  "shifts",
  "shift_assignments",
  "gift_card_purchasers",
] as const;

export type RedactableTable = (typeof REDACTABLE_TABLES)[number];

export const freeTextRedactions = pgTable(
  "free_text_redactions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    columnName: text("column_name").notNull(),
    /** "Guest erase, profile #12", never the guest's name. */
    reason: text("reason").notNull(),
    redactedByUserId: uuid("redacted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "free_text_redactions_table_valid",
      sql`${table.tableName} IN (${sql.raw(REDACTABLE_TABLES.map((name) => `'${name}'`).join(", "))})`,
    ),
    check("free_text_redactions_column_valid", sql`${table.columnName} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check("free_text_redactions_reason_valid", sql`length(trim(${table.reason})) BETWEEN 1 AND 200`),
    index("free_text_redactions_row_idx").on(table.tableName, table.rowId, table.columnName),
  ],
);
