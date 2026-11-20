import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees, positions } from "./employees";
import { locations, organizations } from "./organization";

// Phase 32, owned by Restaurant (policy 2): the manager log and pre-shift notes of a
// location's day of service. The log is append-only (migration 0075): a correction is a new
// entry, and the one permitted change is a single redaction with a reason (policy 6).

/**
 * Phase 33 (policy 17): the categories every organization starts with. Since Phase 33 they are
 * rows of `manager_log_categories`, which managers can add to, rename and deactivate.
 */
export const DEFAULT_MANAGER_LOG_CATEGORIES = [
  { code: "SERVICE", name: "Service", sortOrder: 10 },
  { code: "INCIDENT", name: "Incident", sortOrder: 20 },
  { code: "MAINTENANCE", name: "Maintenance", sortOrder: 30 },
  { code: "STAFFING", name: "Staffing", sortOrder: 40 },
  { code: "GUEST", name: "Guest", sortOrder: 50 },
  { code: "OTHER", name: "Other", sortOrder: 60 },
] as const;

/** Phase 33 (policies 17–18): an organization's log categories, deactivated, never deleted. */
export const managerLogCategories = pgTable(
  "manager_log_categories",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Never changes: entries name their category by this code. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: activeColumn(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("manager_log_categories_org_code_unique").on(table.organizationId, table.code),
    check("manager_log_categories_code_valid", sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,29}$'`),
    check("manager_log_categories_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 40`),
  ],
);

/** One counter per organization for the entry numbers (`LOG-000123`; amendment 1). */
export const managerLogNumberCounters = pgTable(
  "manager_log_number_counters",
  {
    organizationId: uuid("organization_id").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "manager_log_number_counters_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("manager_log_number_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

/** Policies 3–6: one log entry, never changed except by one redaction. */
export const managerLogEntries = pgTable(
  "manager_log_entries",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    entryNumber: integer("entry_number").notNull(),
    businessDate: businessDate().notNull(),
    category: text("category").notNull(),
    /** Empty only once redacted. */
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The author's employee when the entry was written; null for a user without one. */
    authorEmployeeId: uuid("author_employee_id").references(() => employees.id, { onDelete: "restrict" }),
    /** The earlier entry at the same location this one corrects (checked by migration 0075). */
    correctsEntryId: uuid("corrects_entry_id"),
    createdAt: createdAt(),
    redactedAt: timestamptz("redacted_at"),
    redactedByUserId: uuid("redacted_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    redactionReason: text("redaction_reason"),
  },
  (table) => [
    foreignKey({
      name: "manager_log_entries_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "manager_log_entries_corrects_fk",
      columns: [table.correctsEntryId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete("restrict"),
    unique("manager_log_entries_id_org_unique").on(table.id, table.organizationId),
    unique("manager_log_entries_org_number_unique").on(table.organizationId, table.entryNumber),
    check("manager_log_entries_number_positive", sql`${table.entryNumber} > 0`),
    // Phase 33 (policy 17): the category is one of the organization's (added by migration 0077,
    // after the default categories exist).
    foreignKey({
      name: "manager_log_entries_category_fk",
      columns: [table.organizationId, table.category],
      foreignColumns: [managerLogCategories.organizationId, managerLogCategories.code],
    }).onDelete("restrict"),
    check("manager_log_entries_not_self", sql`${table.correctsEntryId} IS NULL OR ${table.correctsEntryId} <> ${table.id}`),
    check(
      "manager_log_entries_body_or_redaction",
      sql`(${table.redactedAt} IS NULL AND ${table.redactedByUserId} IS NULL AND ${table.redactionReason} IS NULL
          AND char_length(${table.body}) BETWEEN 1 AND 4000)
        OR (${table.redactedAt} IS NOT NULL AND ${table.redactedByUserId} IS NOT NULL
          AND char_length(${table.redactionReason}) BETWEEN 1 AND 500 AND ${table.body} = '')`,
    ),
    index("manager_log_entries_location_date_idx").on(table.locationId, table.businessDate, table.createdAt),
    index("manager_log_entries_corrects_idx").on(table.correctsEntryId),
  ],
);

/** Policies 7–8: a briefing for one business date, editable until that date has passed. */
export const preShiftNotes = pgTable(
  "pre_shift_notes",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    businessDate: businessDate().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
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
    /** Phase 33 (policy 5): a redacted note is titled "Redacted", empty and withdrawn, for good. */
    redactedAt: timestamptz("redacted_at"),
    redactedByUserId: uuid("redacted_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    redactionReason: text("redaction_reason"),
  },
  (table) => [
    foreignKey({
      name: "pre_shift_notes_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("pre_shift_notes_id_org_unique").on(table.id, table.organizationId),
    check("pre_shift_notes_title_length", sql`char_length(${table.title}) BETWEEN 1 AND 120`),
    check(
      "pre_shift_notes_body_or_redaction",
      sql`(${table.redactedAt} IS NULL AND ${table.redactedByUserId} IS NULL AND ${table.redactionReason} IS NULL
          AND char_length(${table.body}) BETWEEN 1 AND 2000)
        OR (${table.redactedAt} IS NOT NULL AND ${table.redactedByUserId} IS NOT NULL
          AND char_length(${table.redactionReason}) BETWEEN 1 AND 500 AND ${table.body} = ''
          AND ${table.title} = 'Redacted' AND NOT ${table.active})`,
    ),
    index("pre_shift_notes_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

/** The positions a note is for (policy 9). None means everyone. */
export const preShiftNotePositions = pgTable(
  "pre_shift_note_positions",
  {
    noteId: uuid("note_id").notNull(),
    positionId: uuid("position_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "pre_shift_note_positions_pk", columns: [table.noteId, table.positionId] }),
    foreignKey({
      name: "pre_shift_note_positions_note_fk",
      columns: [table.noteId, table.organizationId],
      foreignColumns: [preShiftNotes.id, preShiftNotes.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "pre_shift_note_positions_position_fk",
      columns: [table.positionId, table.organizationId],
      foreignColumns: [positions.id, positions.organizationId],
    }).onDelete("restrict"),
    index("pre_shift_note_positions_position_idx").on(table.positionId),
  ],
);
