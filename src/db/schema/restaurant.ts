import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import {
  businessDate,
  createdAt,
  timestamptz,
  updatedAt,
} from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees } from "./employees";
import { guestParties } from "./guest-parties";
import { locations, restaurantAreas } from "./organization";

// Occupancy isn't a column here: it derives from `table_session_tables`, and a partial
// unique index lets a physical table have only one open membership at a time. Takeout is
// never a table, and orders will reference `table_sessions`, not `restaurant_tables`.

/** A physical table. `condition` is its physical state, separate from occupancy. */
export const restaurantTables = pgTable(
  "restaurant_tables",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    restaurantAreaId: uuid("restaurant_area_id").notNull(),
    tableNumber: text("table_number").notNull(),
    name: text("name"),
    capacity: integer("capacity").notNull(),
    minimumCapacity: integer("minimum_capacity"),
    condition: text("condition").notNull().default("CLEAN"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("restaurant_tables_location_id_table_number_unique").on(
      table.locationId,
      table.tableNumber,
    ),
    unique("restaurant_tables_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    foreignKey({
      name: "restaurant_tables_area_location_fk",
      columns: [table.restaurantAreaId, table.locationId],
      foreignColumns: [restaurantAreas.id, restaurantAreas.locationId],
    }).onDelete("restrict"),
    check("restaurant_tables_capacity_positive", sql`${table.capacity} > 0`),
    check(
      "restaurant_tables_minimum_capacity_valid",
      sql`${table.minimumCapacity} IS NULL OR (${table.minimumCapacity} > 0 AND ${table.minimumCapacity} <= ${table.capacity})`,
    ),
    check(
      "restaurant_tables_condition_valid",
      sql`${table.condition} IN ('CLEAN', 'DIRTY', 'OUT_OF_SERVICE')`,
    ),
    check(
      "restaurant_tables_table_number_not_blank",
      sql`length(trim(${table.tableNumber})) > 0`,
    ),
    index("restaurant_tables_restaurant_area_id_idx").on(table.restaurantAreaId),
  ],
);

/** Append-only domain history of physical condition. It isn't the audit domain. */
export const tableConditionHistory = pgTable(
  "table_condition_history",
  {
    id: uuidPrimaryKey(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    condition: text("condition").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "table_condition_history_table_fk",
      columns: [table.restaurantTableId],
      foreignColumns: [restaurantTables.id],
    }).onDelete("restrict"),
    check(
      "table_condition_history_condition_valid",
      sql`${table.condition} IN ('CLEAN', 'DIRTY', 'OUT_OF_SERVICE')`,
    ),
    index("table_condition_history_table_id_occurred_at_idx").on(
      table.restaurantTableId,
      table.occurredAt,
    ),
  ],
);

/** The seating of a party at one or more tables. `guest_party_id` links it to the Guest Party. */
export const tableSessions = pgTable(
  "table_sessions",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    guestPartyId: uuid("guest_party_id"),
    partySize: integer("party_size").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    assignedServerEmployeeId: uuid("assigned_server_employee_id").references(
      () => employees.id,
      { onDelete: "restrict" },
    ),
    seatedAt: timestamptz("seated_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelReason: text("cancel_reason"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("table_sessions_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    foreignKey({
      name: "table_sessions_guest_party_location_fk",
      columns: [table.guestPartyId, table.locationId],
      foreignColumns: [guestParties.id, guestParties.locationId],
    }).onDelete("restrict"),
    // A guest party can't be seated twice at once. Walk-ins without a party are exempt.
    uniqueIndex("table_sessions_one_active_per_guest_party_unique")
      .on(table.guestPartyId)
      .where(sql`${table.status} = 'ACTIVE' AND ${table.guestPartyId} IS NOT NULL`),
    check("table_sessions_party_size_positive", sql`${table.partySize} > 0`),
    check(
      "table_sessions_status_valid",
      sql`${table.status} IN ('ACTIVE', 'COMPLETED', 'CANCELLED')`,
    ),
    check(
      "table_sessions_completed_metadata",
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL) AND (${table.completedAt} IS NULL) = (${table.completedByUserId} IS NULL)`,
    ),
    check(
      "table_sessions_cancelled_metadata",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL) AND (${table.cancelledAt} IS NULL) = (${table.cancelledByUserId} IS NULL) AND (${table.cancelledAt} IS NULL) = (${table.cancelReason} IS NULL)`,
    ),
    index("table_sessions_location_id_status_idx").on(
      table.locationId,
      table.status,
    ),
    index("table_sessions_assigned_server_employee_id_idx").on(
      table.assignedServerEmployeeId,
    ),
    // Reporting windows seating history by seated instant (Phase 12).
    index("table_sessions_location_id_seated_at_idx").on(
      table.locationId,
      table.seatedAt,
    ),
  ],
);

/** Which tables a session uses, and when. Rows are ended, never deleted. */
export const tableSessionTables = pgTable(
  "table_session_tables",
  {
    id: uuidPrimaryKey(),
    tableSessionId: uuid("table_session_id").notNull(),
    locationId: uuid("location_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    leftAt: timestamptz("left_at"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "table_session_tables_session_location_fk",
      columns: [table.tableSessionId, table.locationId],
      foreignColumns: [tableSessions.id, tableSessions.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "table_session_tables_table_location_fk",
      columns: [table.restaurantTableId, table.locationId],
      foreignColumns: [restaurantTables.id, restaurantTables.locationId],
    }).onDelete("restrict"),
    uniqueIndex("table_session_tables_one_open_per_table_unique")
      .on(table.restaurantTableId)
      .where(sql`${table.leftAt} IS NULL`),
    check(
      "table_session_tables_left_after_joined",
      sql`${table.leftAt} IS NULL OR ${table.leftAt} >= ${table.joinedAt}`,
    ),
    index("table_session_tables_table_session_id_idx").on(table.tableSessionId),
  ],
);

/**
 * Append-only record of each explicit manager override. A session can be overridden more
 * than once, so these don't live on the session. It holds overrides only and isn't an
 * audit log.
 */
export const tableSessionOverrides = pgTable(
  "table_session_overrides",
  {
    id: uuidPrimaryKey(),
    tableSessionId: uuid("table_session_id")
      .notNull()
      .references(() => tableSessions.id, { onDelete: "restrict" }),
    overrideType: text("override_type").notNull(),
    reason: text("reason").notNull(),
    overriddenByUserId: uuid("overridden_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    serverEmployeeId: uuid("server_employee_id").references(() => employees.id, {
      onDelete: "restrict",
    }),
    partySize: integer("party_size"),
    seatedCapacity: integer("seated_capacity"),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "table_session_overrides_type_valid",
      sql`${table.overrideType} IN ('CAPACITY', 'SERVER_SCHEDULE')`,
    ),
    check(
      "table_session_overrides_reason_not_blank",
      sql`length(trim(${table.reason})) > 0`,
    ),
    check(
      "table_session_overrides_details_match_type",
      sql`(${table.overrideType} = 'SERVER_SCHEDULE') = (${table.serverEmployeeId} IS NOT NULL) AND (${table.overrideType} = 'CAPACITY') = (${table.partySize} IS NOT NULL) AND (${table.partySize} IS NULL) = (${table.seatedCapacity} IS NULL)`,
    ),
    index("table_session_overrides_table_session_id_idx").on(
      table.tableSessionId,
    ),
  ],
);

/** A configured group of tables. It belongs to no particular employee. */
export const serverSections = pgTable(
  "server_sections",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    restaurantAreaId: uuid("restaurant_area_id"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("server_sections_location_id_code_unique").on(
      table.locationId,
      table.code,
    ),
    unique("server_sections_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    foreignKey({
      name: "server_sections_area_location_fk",
      columns: [table.restaurantAreaId, table.locationId],
      foreignColumns: [restaurantAreas.id, restaurantAreas.locationId],
    }).onDelete("restrict"),
  ],
);

/** A table has at most one active section. Removed memberships keep their row. */
export const serverSectionTables = pgTable(
  "server_section_tables",
  {
    id: uuidPrimaryKey(),
    serverSectionId: uuid("server_section_id").notNull(),
    locationId: uuid("location_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "server_section_tables_section_location_fk",
      columns: [table.serverSectionId, table.locationId],
      foreignColumns: [serverSections.id, serverSections.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "server_section_tables_table_location_fk",
      columns: [table.restaurantTableId, table.locationId],
      foreignColumns: [restaurantTables.id, restaurantTables.locationId],
    }).onDelete("restrict"),
    uniqueIndex("server_section_tables_one_active_per_table_unique")
      .on(table.restaurantTableId)
      .where(sql`${table.active}`),
    index("server_section_tables_server_section_id_idx").on(
      table.serverSectionId,
    ),
  ],
);

/** Who works a section on a business date. Rows are ended, never deleted. */
export const serverSectionAssignments = pgTable(
  "server_section_assignments",
  {
    id: uuidPrimaryKey(),
    serverSectionId: uuid("server_section_id").notNull(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    businessDate: businessDate().notNull(),
    effectiveFrom: timestamptz("effective_from").notNull().defaultNow(),
    effectiveTo: timestamptz("effective_to"),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    scheduleOverrideReason: text("schedule_override_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "server_section_assignments_section_fk",
      columns: [table.serverSectionId],
      foreignColumns: [serverSections.id],
    }).onDelete("restrict"),
    uniqueIndex("server_section_assignments_one_open_per_date_unique")
      .on(table.serverSectionId, table.businessDate)
      .where(sql`${table.effectiveTo} IS NULL`),
    check(
      "server_section_assignments_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "server_section_assignments_ended_metadata",
      sql`(${table.effectiveTo} IS NULL) = (${table.endedByUserId} IS NULL)`,
    ),
    check(
      "server_section_assignments_override_reason_not_blank",
      sql`${table.scheduleOverrideReason} IS NULL OR length(trim(${table.scheduleOverrideReason})) > 0`,
    ),
    index("server_section_assignments_employee_id_business_date_idx").on(
      table.employeeId,
      table.businessDate,
    ),
  ],
);
