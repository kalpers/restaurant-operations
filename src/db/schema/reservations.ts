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

import { uuidPrimaryKey } from "../helpers/columns";
import {
  businessDate,
  createdAt,
  timestamptz,
  updatedAt,
} from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { guestParties } from "./guest-parties";
import { restaurantAreas } from "./organization";
import { restaurantTables, tableSessions } from "./restaurant";

// Everything here is planning. A reservation or waitlist table assignment never makes a
// table occupied: only an open `table_session_tables` row does. Planned and actual tables
// are kept apart so analysis can compare them later.

/** One arrival plan for a Guest Party. It doesn't own a table session. */
export const reservations = pgTable(
  "reservations",
  {
    id: uuidPrimaryKey(),
    guestPartyId: uuid("guest_party_id").notNull(),
    locationId: uuid("location_id").notNull(),
    reservationAt: timestamptz("reservation_at").notNull(),
    /** From BusinessDateService, never from truncating the instant. */
    businessDate: businessDate().notNull(),
    expectedDurationMinutes: integer("expected_duration_minutes").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    notes: text("notes"),
    checkedInAt: timestamptz("checked_in_at"),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelReason: text("cancel_reason"),
    noShowAt: timestamptz("no_show_at"),
    noShowByUserId: uuid("no_show_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "reservations_guest_party_location_fk",
      columns: [table.guestPartyId, table.locationId],
      foreignColumns: [guestParties.id, guestParties.locationId],
    }).onDelete("restrict"),
    unique("reservations_guest_party_id_unique").on(table.guestPartyId),
    unique("reservations_id_location_id_unique").on(table.id, table.locationId),
    check(
      "reservations_status_valid",
      sql`${table.status} IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    ),
    check(
      "reservations_source_valid",
      sql`${table.source} IN ('PHONE', 'IN_PERSON', 'INTERNAL', 'WALK_IN_FUTURE')`,
    ),
    check(
      "reservations_duration_positive",
      sql`${table.expectedDurationMinutes} > 0`,
    ),
    check(
      "reservations_cancelled_metadata",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL) AND (${table.cancelledAt} IS NULL) = (${table.cancelledByUserId} IS NULL)`,
    ),
    check(
      "reservations_no_show_metadata",
      sql`(${table.status} = 'NO_SHOW') = (${table.noShowAt} IS NOT NULL) AND (${table.noShowAt} IS NULL) = (${table.noShowByUserId} IS NULL)`,
    ),
    index("reservations_location_id_business_date_idx").on(
      table.locationId,
      table.businessDate,
    ),
    index("reservations_location_id_status_reservation_at_idx").on(
      table.locationId,
      table.status,
      table.reservationAt,
    ),
  ],
);

/** Planned tables. A row is ended, never deleted, so planning history survives seating. */
export const reservationTableAssignments = pgTable(
  "reservation_table_assignments",
  {
    id: uuidPrimaryKey(),
    reservationId: uuid("reservation_id").notNull(),
    locationId: uuid("location_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    removalReason: text("removal_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "reservation_table_assignments_reservation_location_fk",
      columns: [table.reservationId, table.locationId],
      foreignColumns: [reservations.id, reservations.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "reservation_table_assignments_table_location_fk",
      columns: [table.restaurantTableId, table.locationId],
      foreignColumns: [restaurantTables.id, restaurantTables.locationId],
    }).onDelete("restrict"),
    uniqueIndex("reservation_table_assignments_one_active_unique")
      .on(table.reservationId, table.restaurantTableId)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      "reservation_table_assignments_removal_valid",
      sql`(${table.removedAt} IS NULL) = (${table.removalReason} IS NULL) AND (${table.removalReason} IS NULL OR ${table.removalReason} IN ('REPLACED', 'CANCELLED', 'NO_SHOW', 'SEATED', 'REMOVED'))`,
    ),
    index("reservation_table_assignments_table_idx").on(
      table.restaurantTableId,
    ),
  ],
);

/** Append-only record of a manager seating an unrelated party under a reservation hold. */
export const reservationHoldOverrides = pgTable(
  "reservation_hold_overrides",
  {
    id: uuidPrimaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    tableSessionId: uuid("table_session_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    category: text("category").notNull().default("RESERVATION_HOLD_OVERRIDE"),
    reason: text("reason").notNull(),
    overriddenByUserId: uuid("overridden_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    // Named explicitly: the generated names exceed PostgreSQL's 63-character limit.
    foreignKey({
      name: "reservation_hold_overrides_session_fk",
      columns: [table.tableSessionId],
      foreignColumns: [tableSessions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "reservation_hold_overrides_table_fk",
      columns: [table.restaurantTableId],
      foreignColumns: [restaurantTables.id],
    }).onDelete("restrict"),
    check(
      "reservation_hold_overrides_category_valid",
      sql`${table.category} = 'RESERVATION_HOLD_OVERRIDE'`,
    ),
    check(
      "reservation_hold_overrides_reason_not_blank",
      sql`length(trim(${table.reason})) > 0`,
    ),
    index("reservation_hold_overrides_reservation_id_idx").on(
      table.reservationId,
    ),
  ],
);

/** A party waiting for a table. `NOTIFIED` means staff recorded contacting them. */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuidPrimaryKey(),
    guestPartyId: uuid("guest_party_id").notNull(),
    locationId: uuid("location_id").notNull(),
    status: text("status").notNull(),
    quotedWaitMinutes: integer("quoted_wait_minutes"),
    preferredAreaId: uuid("preferred_area_id"),
    addedAt: timestamptz("added_at").notNull().defaultNow(),
    notifiedAt: timestamptz("notified_at"),
    notifiedByUserId: uuid("notified_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    seatedAt: timestamptz("seated_at"),
    removedAt: timestamptz("removed_at"),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "waitlist_entries_guest_party_location_fk",
      columns: [table.guestPartyId, table.locationId],
      foreignColumns: [guestParties.id, guestParties.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "waitlist_entries_preferred_area_location_fk",
      columns: [table.preferredAreaId, table.locationId],
      foreignColumns: [restaurantAreas.id, restaurantAreas.locationId],
    }).onDelete("restrict"),
    unique("waitlist_entries_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    uniqueIndex("waitlist_entries_one_open_per_party_unique")
      .on(table.guestPartyId)
      .where(sql`${table.status} IN ('WAITING', 'NOTIFIED', 'TABLE_ASSIGNED')`),
    check(
      "waitlist_entries_status_valid",
      sql`${table.status} IN ('WAITING', 'NOTIFIED', 'TABLE_ASSIGNED', 'SEATED', 'CANCELLED', 'LEFT')`,
    ),
    check(
      "waitlist_entries_quote_non_negative",
      sql`${table.quotedWaitMinutes} IS NULL OR ${table.quotedWaitMinutes} >= 0`,
    ),
    check(
      "waitlist_entries_seated_metadata",
      sql`(${table.status} = 'SEATED') = (${table.seatedAt} IS NOT NULL)`,
    ),
    check(
      "waitlist_entries_removed_metadata",
      sql`(${table.status} IN ('CANCELLED', 'LEFT')) = (${table.removedAt} IS NOT NULL) AND (${table.removedAt} IS NULL) = (${table.removedByUserId} IS NULL)`,
    ),
    index("waitlist_entries_location_id_status_idx").on(
      table.locationId,
      table.status,
    ),
  ],
);

/** The host's planned table selection. It's replaceable and creates no occupancy. */
export const waitlistTableAssignments = pgTable(
  "waitlist_table_assignments",
  {
    id: uuidPrimaryKey(),
    waitlistEntryId: uuid("waitlist_entry_id").notNull(),
    locationId: uuid("location_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
    removalReason: text("removal_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "waitlist_table_assignments_entry_location_fk",
      columns: [table.waitlistEntryId, table.locationId],
      foreignColumns: [waitlistEntries.id, waitlistEntries.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "waitlist_table_assignments_table_location_fk",
      columns: [table.restaurantTableId, table.locationId],
      foreignColumns: [restaurantTables.id, restaurantTables.locationId],
    }).onDelete("restrict"),
    uniqueIndex("waitlist_table_assignments_one_active_unique")
      .on(table.waitlistEntryId, table.restaurantTableId)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      "waitlist_table_assignments_removal_valid",
      sql`(${table.removedAt} IS NULL) = (${table.removalReason} IS NULL) AND (${table.removalReason} IS NULL OR ${table.removalReason} IN ('REPLACED', 'SEATED', 'CANCELLED', 'LEFT', 'REMOVED'))`,
    ),
  ],
);
