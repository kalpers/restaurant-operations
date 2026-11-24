import { sql } from "drizzle-orm";
import { check, foreignKey, index, numeric, pgTable, smallint, text, unique, uuid, boolean } from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees } from "./employees";
import { locations, organizations } from "./organization";

// Phase 36 part 2, owned by Restaurant (policy 6): food-safety temperature logs. Check points
// are a location's configuration, deactivated never deleted. Readings are append-only
// (migration 0084): a mistake is fixed by a new reading that names the one it corrects, and the
// only change ever made is a guest erase's recorded word-level redaction of a corrective action.

export const TEMPERATURE_POINT_KINDS = [
  "COLD_HOLDING",
  "FROZEN",
  "HOT_HOLDING",
  "COOKING",
  "COOLING",
  "RECEIVING",
  "OTHER",
] as const;
export type TemperaturePointKind = (typeof TEMPERATURE_POINT_KINDS)[number];

export const TEMPERATURE_UNITS = ["F", "C"] as const;
export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/** Policy 6: a cooler, freezer, hot-holding well or food being checked. */
export const temperaturePoints = pgTable(
  "temperature_points",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** Fixed when created, so no reading is ever converted. */
    unit: text("unit").notNull(),
    minimumValue: numeric("minimum_value", { precision: 5, scale: 1, mode: "string" }),
    maximumValue: numeric("maximum_value", { precision: 5, scale: 1, mode: "string" }),
    /** How often it should be checked; null means no schedule. */
    checkIntervalMinutes: smallint("check_interval_minutes"),
    sortOrder: smallint("sort_order").notNull().default(0),
    active: activeColumn(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "temperature_points_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("temperature_points_id_location_unique").on(table.id, table.locationId),
    check("temperature_points_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    check("temperature_points_kind_valid", sql`${table.kind} IN (${inList(TEMPERATURE_POINT_KINDS)})`),
    check("temperature_points_unit_valid", sql`${table.unit} IN (${inList(TEMPERATURE_UNITS)})`),
    check(
      "temperature_points_range_valid",
      sql`${table.minimumValue} IS NULL OR ${table.maximumValue} IS NULL OR ${table.minimumValue} <= ${table.maximumValue}`,
    ),
    check(
      "temperature_points_interval_valid",
      sql`${table.checkIntervalMinutes} IS NULL OR ${table.checkIntervalMinutes} BETWEEN 30 AND 1440`,
    ),
    index("temperature_points_location_idx").on(table.locationId, table.active),
  ],
);

/** Policy 6: one reading, never changed. Its point's range is copied onto it. */
export const temperatureReadings = pgTable(
  "temperature_readings",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    pointId: uuid("point_id").notNull(),
    pointNameSnapshot: text("point_name_snapshot").notNull(),
    value: numeric("value", { precision: 5, scale: 1, mode: "string" }).notNull(),
    unit: text("unit").notNull(),
    minimumValue: numeric("minimum_value", { precision: 5, scale: 1, mode: "string" }),
    maximumValue: numeric("maximum_value", { precision: 5, scale: 1, mode: "string" }),
    inRange: boolean("in_range").notNull(),
    correctiveAction: text("corrective_action"),
    takenAt: timestamptz("taken_at").notNull(),
    businessDate: businessDate().notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedByEmployeeId: uuid("recorded_by_employee_id").references(() => employees.id, { onDelete: "restrict" }),
    /** A recheck after an out-of-range reading. */
    followsUpReadingId: uuid("follows_up_reading_id"),
    /** A mistaken reading this one replaces; the original stays. */
    correctsReadingId: uuid("corrects_reading_id"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "temperature_readings_point_location_fk",
      columns: [table.pointId, table.locationId],
      foreignColumns: [temperaturePoints.id, temperaturePoints.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "temperature_readings_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "temperature_readings_follows_up_fk",
      columns: [table.followsUpReadingId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "temperature_readings_corrects_fk",
      columns: [table.correctsReadingId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    check("temperature_readings_unit_valid", sql`${table.unit} IN (${inList(TEMPERATURE_UNITS)})`),
    check("temperature_readings_value_plausible", sql`${table.value} BETWEEN -100 AND 600`),
    // Policy 6: in range is worked out from the copied range, never chosen.
    check(
      "temperature_readings_in_range_matches",
      sql`${table.inRange} = ((${table.minimumValue} IS NULL OR ${table.value} >= ${table.minimumValue})
        AND (${table.maximumValue} IS NULL OR ${table.value} <= ${table.maximumValue}))`,
    ),
    // Policy 6: an out-of-range reading says what was done about it.
    check(
      "temperature_readings_corrective_action",
      sql`(${table.inRange} OR ${table.correctiveAction} IS NOT NULL)
        AND (${table.correctiveAction} IS NULL OR char_length(${table.correctiveAction}) BETWEEN 1 AND 500)`,
    ),
    check("temperature_readings_no_card_digits", sql`coalesce(${table.correctiveAction}, '') !~ '[0-9]{13,}'`),
    check(
      "temperature_readings_not_self",
      sql`(${table.followsUpReadingId} IS NULL OR ${table.followsUpReadingId} <> ${table.id})
        AND (${table.correctsReadingId} IS NULL OR ${table.correctsReadingId} <> ${table.id})`,
    ),
    index("temperature_readings_location_date_idx").on(table.locationId, table.businessDate, table.takenAt),
    index("temperature_readings_point_taken_idx").on(table.pointId, table.takenAt),
    index("temperature_readings_corrects_idx").on(table.correctsReadingId),
  ],
);
