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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees, positions } from "./employees";
import { locations, organizations } from "./organization";

// Phase 36 part 1, owned by Restaurant (policy 5): opening, closing and side-work checklists.
// Templates are a location's configuration, deactivated never deleted. A run is one business
// date's copy of a template's active items, so editing a template never changes a started run
// (rule 4). A completed run is frozen (migration 0082), apart from its one sign-off and a guest
// erase's word-level redaction of notes.

export const CHECKLIST_KINDS = ["OPENING", "CLOSING", "SIDE_WORK", "OTHER"] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

export const CHECKLIST_RUN_STATUSES = ["OPEN", "COMPLETED"] as const;
export type ChecklistRunStatus = (typeof CHECKLIST_RUN_STATUSES)[number];

export const CHECKLIST_ITEM_STATES = ["OPEN", "DONE", "SKIPPED"] as const;
export type ChecklistItemState = (typeof CHECKLIST_ITEM_STATES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/** Policy 5: a location's checklist template. */
export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** A manager other than the one who completed it signs the run off. */
    requiresSignOff: boolean("requires_sign_off").notNull().default(false),
    active: activeColumn(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "checklist_templates_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("checklist_templates_id_org_unique").on(table.id, table.organizationId),
    unique("checklist_templates_id_location_unique").on(table.id, table.locationId),
    check("checklist_templates_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    check("checklist_templates_kind_valid", sql`${table.kind} IN (${inList(CHECKLIST_KINDS)})`),
    index("checklist_templates_location_idx").on(table.locationId, table.active),
  ],
);

/** The positions a template is for (relevance, not access). None means everyone. */
export const checklistTemplatePositions = pgTable(
  "checklist_template_positions",
  {
    templateId: uuid("template_id").notNull(),
    positionId: uuid("position_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "checklist_template_positions_pk", columns: [table.templateId, table.positionId] }),
    foreignKey({
      name: "checklist_template_positions_template_fk",
      columns: [table.templateId, table.organizationId],
      foreignColumns: [checklistTemplates.id, checklistTemplates.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "checklist_template_positions_position_fk",
      columns: [table.positionId, table.organizationId],
      foreignColumns: [positions.id, positions.organizationId],
    }).onDelete("restrict"),
    index("checklist_template_positions_position_idx").on(table.positionId),
  ],
);

/** One task of a template. Deactivated, never deleted. */
export const checklistTemplateItems = pgTable(
  "checklist_template_items",
  {
    id: uuidPrimaryKey(),
    templateId: uuid("template_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    text: text("text").notNull(),
    required: boolean("required").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "checklist_template_items_template_fk",
      columns: [table.templateId, table.organizationId],
      foreignColumns: [checklistTemplates.id, checklistTemplates.organizationId],
    }).onDelete("restrict"),
    check("checklist_template_items_text_length", sql`char_length(${table.text}) BETWEEN 1 AND 200`),
    check("checklist_template_items_sort_valid", sql`${table.sortOrder} BETWEEN 0 AND 10000`),
    index("checklist_template_items_template_idx").on(table.templateId, table.sortOrder),
  ],
);

/** Policy 5: one business date's checklist, copied from its template when started. */
export const checklistRuns = pgTable(
  "checklist_runs",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    templateId: uuid("template_id").notNull(),
    businessDate: businessDate().notNull(),
    kind: text("kind").notNull(),
    templateNameSnapshot: text("template_name_snapshot").notNull(),
    requiresSignOff: boolean("requires_sign_off").notNull(),
    /** Side work only: whose run it is. */
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("OPEN"),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    completedAt: timestamptz("completed_at"),
    signedOffByUserId: uuid("signed_off_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    signedOffAt: timestamptz("signed_off_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "checklist_runs_template_location_fk",
      columns: [table.templateId, table.locationId],
      foreignColumns: [checklistTemplates.id, checklistTemplates.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "checklist_runs_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("checklist_runs_id_org_unique").on(table.id, table.organizationId),
    check("checklist_runs_kind_valid", sql`${table.kind} IN (${inList(CHECKLIST_KINDS)})`),
    check("checklist_runs_status_valid", sql`${table.status} IN (${inList(CHECKLIST_RUN_STATUSES)})`),
    check(
      "checklist_runs_employee_for_side_work",
      sql`(${table.kind} = 'SIDE_WORK') = (${table.employeeId} IS NOT NULL)`,
    ),
    check(
      "checklist_runs_completion_recorded",
      sql`(${table.status} = 'OPEN' AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL)
        OR (${table.status} = 'COMPLETED' AND ${table.completedAt} IS NOT NULL AND ${table.completedByUserId} IS NOT NULL)`,
    ),
    check(
      "checklist_runs_sign_off_recorded",
      sql`(${table.signedOffAt} IS NULL AND ${table.signedOffByUserId} IS NULL)
        OR (${table.signedOffAt} IS NOT NULL AND ${table.signedOffByUserId} IS NOT NULL
          AND ${table.status} = 'COMPLETED' AND ${table.requiresSignOff}
          AND ${table.signedOffByUserId} <> ${table.completedByUserId})`,
    ),
    // Policy 5: one run per template and date, or per template, employee and date for side work.
    uniqueIndex("checklist_runs_template_date_unique")
      .on(table.templateId, table.businessDate)
      .where(sql`${table.employeeId} IS NULL`),
    uniqueIndex("checklist_runs_template_date_employee_unique")
      .on(table.templateId, table.businessDate, table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL`),
    index("checklist_runs_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

/** One task of a run, ticked done or skipped, each with its own version. */
export const checklistRunItems = pgTable(
  "checklist_run_items",
  {
    id: uuidPrimaryKey(),
    runId: uuid("run_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    templateItemId: uuid("template_item_id").notNull(),
    textSnapshot: text("text_snapshot").notNull(),
    required: boolean("required").notNull(),
    sortOrder: integer("sort_order").notNull(),
    state: text("state").notNull().default("OPEN"),
    actedByUserId: uuid("acted_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    actedAt: timestamptz("acted_at"),
    skipReason: text("skip_reason"),
    note: text("note"),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "checklist_run_items_run_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [checklistRuns.id, checklistRuns.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "checklist_run_items_template_item_fk",
      columns: [table.templateItemId],
      foreignColumns: [checklistTemplateItems.id],
    }).onDelete("restrict"),
    unique("checklist_run_items_run_template_item_unique").on(table.runId, table.templateItemId),
    check("checklist_run_items_state_valid", sql`${table.state} IN (${inList(CHECKLIST_ITEM_STATES)})`),
    check(
      "checklist_run_items_state_recorded",
      sql`(${table.state} = 'OPEN' AND ${table.actedAt} IS NULL AND ${table.actedByUserId} IS NULL AND ${table.skipReason} IS NULL)
        OR (${table.state} = 'DONE' AND ${table.actedAt} IS NOT NULL AND ${table.actedByUserId} IS NOT NULL AND ${table.skipReason} IS NULL)
        OR (${table.state} = 'SKIPPED' AND ${table.actedAt} IS NOT NULL AND ${table.actedByUserId} IS NOT NULL
          AND char_length(${table.skipReason}) BETWEEN 1 AND 200)`,
    ),
    check("checklist_run_items_note_length", sql`${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 500`),
    // Rule 15: nothing that could be a card number in free text.
    check(
      "checklist_run_items_no_card_digits",
      sql`coalesce(${table.note}, '') !~ '[0-9]{13,}' AND coalesce(${table.skipReason}, '') !~ '[0-9]{13,}'`,
    ),
    index("checklist_run_items_run_idx").on(table.runId, table.sortOrder),
  ],
);
