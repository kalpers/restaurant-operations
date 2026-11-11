import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees, positions } from "./employees";
import { idempotencyRecords } from "./infrastructure";
import { locations, organizations } from "./organization";
import { shiftAssignments } from "./scheduling";

// Phase 18 time clock, owned by Scheduling (approved policies A1-A12). An entry is one
// stretch of work in one Position. `clock_in_at`/`clock_out_at` are the effective times that
// reports use; `*_recorded_at` are the original punch instants, written once and frozen by a
// trigger (migration 0036), so an adjusted entry keeps both. Overlapping non-voided entries
// for one employee are refused by an exclusion constraint in the same migration.

export const TIME_ENTRY_STATUSES = ["OPEN", "CLOSED", "VOIDED"] as const;
/** SELF and MANAGER are punches. ADJUSTMENT is a clock-out a manager set afterwards: no punch happened. */
export const PUNCH_SOURCES = ["SELF", "MANAGER", "ADJUSTMENT"] as const;

export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    shiftAssignmentId: uuid("shift_assignment_id").references(() => shiftAssignments.id, {
      onDelete: "restrict",
    }),
    businessDate: businessDate().notNull(),
    status: text("status").notNull().default("OPEN"),
    clockInAt: timestamptz("clock_in_at").notNull(),
    clockOutAt: timestamptz("clock_out_at"),
    clockInRecordedAt: timestamptz("clock_in_recorded_at").notNull(),
    clockOutRecordedAt: timestamptz("clock_out_recorded_at"),
    clockInSource: text("clock_in_source").notNull(),
    clockOutSource: text("clock_out_source"),
    clockInByUserId: uuid("clock_in_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clockOutByUserId: uuid("clock_out_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    clockInIdempotencyRecordId: uuid("clock_in_idempotency_record_id").notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "time_entries_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "time_entries_clock_in_idempotency_fk",
      columns: [table.clockInIdempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    uniqueIndex("time_entries_clock_in_idempotency_unique").on(table.clockInIdempotencyRecordId),
    uniqueIndex("time_entries_one_open_per_employee")
      .on(table.employeeId)
      .where(sql`${table.status} = 'OPEN'`),
    check("time_entries_status_valid", sql`${table.status} IN ('OPEN', 'CLOSED', 'VOIDED')`),
    check(
      "time_entries_sources_valid",
      sql`${table.clockInSource} IN ('SELF', 'MANAGER')
        AND (${table.clockOutSource} IS NULL OR ${table.clockOutSource} IN ('SELF', 'MANAGER', 'ADJUSTMENT'))`,
    ),
    check(
      "time_entries_clock_out_fields",
      sql`(${table.clockOutAt} IS NULL) = (${table.clockOutSource} IS NULL)
        AND (${table.clockOutAt} IS NULL) = (${table.clockOutByUserId} IS NULL)
        AND (${table.clockOutRecordedAt} IS NULL) = (${table.clockOutSource} IS NULL OR ${table.clockOutSource} = 'ADJUSTMENT')
        AND (${table.status} <> 'OPEN' OR ${table.clockOutAt} IS NULL)
        AND (${table.status} <> 'CLOSED' OR ${table.clockOutAt} IS NOT NULL)`,
    ),
    check(
      "time_entries_clock_out_after_in",
      sql`${table.clockOutAt} IS NULL OR ${table.clockOutAt} > ${table.clockInAt}`,
    ),
    check(
      "time_entries_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)
        AND (${table.voidReason} IS NULL OR (length(trim(${table.voidReason})) > 0 AND ${table.voidReason} !~ '[0-9]{13,}'))`,
    ),
    index("time_entries_location_date_idx").on(table.locationId, table.businessDate),
    index("time_entries_employee_date_idx").on(table.employeeId, table.businessDate),
    index("time_entries_shift_assignment_idx").on(table.shiftAssignmentId),
  ],
);

/**
 * A break inside an entry. Unpaid breaks are subtracted from worked hours. A removed break
 * keeps its row (`removed_at`), and the adjustment that removed it records the before values.
 */
export const timeEntryBreaks = pgTable(
  "time_entry_breaks",
  {
    id: uuidPrimaryKey(),
    timeEntryId: uuid("time_entry_id")
      .notNull()
      .references(() => timeEntries.id, { onDelete: "restrict" }),
    startedAt: timestamptz("started_at").notNull(),
    endedAt: timestamptz("ended_at"),
    paid: boolean("paid").notNull().default(false),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    removedAt: timestamptz("removed_at"),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("time_entry_breaks_end_after_start", sql`${table.endedAt} IS NULL OR ${table.endedAt} > ${table.startedAt}`),
    check(
      "time_entry_breaks_removed_fields",
      sql`(${table.removedAt} IS NULL) = (${table.removedByUserId} IS NULL)`,
    ),
    uniqueIndex("time_entry_breaks_one_open_per_entry")
      .on(table.timeEntryId)
      .where(sql`${table.endedAt} IS NULL AND ${table.removedAt} IS NULL`),
    index("time_entry_breaks_entry_idx").on(table.timeEntryId),
  ],
);

/** Append-only history of manager corrections (policy A8). `changes` holds allow-listed before/after values. */
export const timeEntryAdjustments = pgTable(
  "time_entry_adjustments",
  {
    id: uuidPrimaryKey(),
    timeEntryId: uuid("time_entry_id")
      .notNull()
      .references(() => timeEntries.id, { onDelete: "restrict" }),
    adjustedByUserId: uuid("adjusted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    adjustedAt: timestamptz("adjusted_at").notNull(),
    reason: text("reason").notNull(),
    changes: jsonb("changes").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "time_entry_adjustments_reason",
      sql`length(trim(${table.reason})) > 0 AND ${table.reason} !~ '[0-9]{13,}'`,
    ),
    index("time_entry_adjustments_entry_idx").on(table.timeEntryId, table.adjustedAt),
  ],
);
