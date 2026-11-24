import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, pgTable, primaryKey, smallint, text, unique, uuid } from "drizzle-orm/pg-core";

import { money } from "../helpers/numeric";
import { uuidPrimaryKey } from "../helpers/columns";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { guestParties } from "./guest-parties";
import { menuItems } from "./menu";
import { locations, organizations, restaurantAreas } from "./organization";
import { restaurantTables } from "./restaurant";

// Phase 36 part 3, owned by Reservations (policy 7): event and private-dining bookings. An event
// is a planned Guest Party, like a reservation, so the party holds the contact details, guest
// count and allergies. TENTATIVE and CONFIRMED events block their space (chosen tables in one
// area, a whole area, or the whole location) over `[starts_at - setup, ends_at + teardown)`.
// Deposits and minimum spend are information only: nothing here holds or moves money.

export const EVENT_STATUSES = ["INQUIRY", "TENTATIVE", "CONFIRMED", "COMPLETED", "CANCELLED"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The statuses that hold the space (policy 7). */
export const EVENT_BLOCKING_STATUSES = ["TENTATIVE", "CONFIRMED"] as const satisfies readonly EventStatus[];

export const EVENT_SPACE_SCOPES = ["TABLES", "AREA", "LOCATION"] as const;
export type EventSpaceScope = (typeof EVENT_SPACE_SCOPES)[number];

export const EVENT_DEPOSIT_METHODS = ["CASH", "EXTERNAL_CARD", "OTHER"] as const;
export type EventDepositMethod = (typeof EVENT_DEPOSIT_METHODS)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/** One counter per organization for the event numbers (`EV-000123`). */
export const eventNumberCounters = pgTable(
  "event_number_counters",
  {
    organizationId: uuid("organization_id").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "event_number_counters_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("event_number_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

export const eventBookings = pgTable(
  "event_bookings",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    /** The event's own Guest Party: contact, guest count and allergies live there. */
    guestPartyId: uuid("guest_party_id").notNull(),
    eventNumber: integer("event_number").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    spaceScope: text("space_scope").notNull(),
    /** The area of an AREA event, and the one area a TABLES event's tables are in. */
    restaurantAreaId: uuid("restaurant_area_id"),
    startsAt: timestamptz("starts_at").notNull(),
    endsAt: timestamptz("ends_at").notNull(),
    setupMinutes: smallint("setup_minutes").notNull().default(0),
    teardownMinutes: smallint("teardown_minutes").notNull().default(0),
    /** From BusinessDateService for `starts_at`. */
    businessDate: businessDate().notNull(),
    notes: text("notes"),
    menuNotes: text("menu_notes"),
    /** A set menu, typically a prix-fixe item. Shown on the event sheet; nothing is rung up from it. */
    menuItemId: uuid("menu_item_id").references(() => menuItems.id, { onDelete: "restrict" }),
    minimumSpend: money("minimum_spend"),
    depositAgreed: money("deposit_agreed"),
    depositReceived: money("deposit_received"),
    depositReceivedOn: date("deposit_received_on", { mode: "string" }),
    depositMethod: text("deposit_method"),
    depositReference: text("deposit_reference"),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelReason: text("cancel_reason"),
    completedAt: timestamptz("completed_at"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "event_bookings_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_bookings_party_location_fk",
      columns: [table.guestPartyId, table.locationId],
      foreignColumns: [guestParties.id, guestParties.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_bookings_area_fk",
      columns: [table.restaurantAreaId],
      foreignColumns: [restaurantAreas.id],
    }).onDelete("restrict"),
    unique("event_bookings_party_unique").on(table.guestPartyId),
    unique("event_bookings_org_number_unique").on(table.organizationId, table.eventNumber),
    check("event_bookings_number_positive", sql`${table.eventNumber} > 0`),
    check("event_bookings_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check("event_bookings_status_valid", sql`${table.status} IN (${inList(EVENT_STATUSES)})`),
    check("event_bookings_scope_valid", sql`${table.spaceScope} IN (${inList(EVENT_SPACE_SCOPES)})`),
    check(
      "event_bookings_area_matches_scope",
      sql`(${table.spaceScope} = 'LOCATION') = (${table.restaurantAreaId} IS NULL)`,
    ),
    check(
      "event_bookings_times_valid",
      sql`${table.endsAt} > ${table.startsAt} AND ${table.endsAt} <= ${table.startsAt} + interval '24 hours'`,
    ),
    check(
      "event_bookings_buffers_valid",
      sql`${table.setupMinutes} BETWEEN 0 AND 480 AND ${table.teardownMinutes} BETWEEN 0 AND 480`,
    ),
    check("event_bookings_notes_length", sql`${table.notes} IS NULL OR char_length(${table.notes}) BETWEEN 1 AND 4000`),
    check("event_bookings_menu_notes_length", sql`${table.menuNotes} IS NULL OR char_length(${table.menuNotes}) BETWEEN 1 AND 2000`),
    check(
      "event_bookings_money_non_negative",
      sql`coalesce(${table.minimumSpend}, 0) >= 0 AND coalesce(${table.depositAgreed}, 0) >= 0 AND coalesce(${table.depositReceived}, 0) >= 0`,
    ),
    check(
      "event_bookings_deposit_recorded",
      sql`(${table.depositReceived} IS NULL AND ${table.depositReceivedOn} IS NULL AND ${table.depositMethod} IS NULL AND ${table.depositReference} IS NULL)
        OR (${table.depositReceived} IS NOT NULL AND ${table.depositReceivedOn} IS NOT NULL
          AND ${table.depositMethod} IN (${inList(EVENT_DEPOSIT_METHODS)})
          AND (${table.depositReference} IS NULL OR char_length(${table.depositReference}) BETWEEN 1 AND 80))`,
    ),
    check(
      "event_bookings_cancellation_recorded",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)
        AND (${table.cancelledAt} IS NULL OR (${table.cancelledByUserId} IS NOT NULL AND char_length(${table.cancelReason}) BETWEEN 1 AND 500))`,
    ),
    check("event_bookings_completion_recorded", sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`),
    // Rule 15: nothing that could be a card number in free text.
    check(
      "event_bookings_no_card_digits",
      sql`${table.name} !~ '[0-9]{13,}' AND coalesce(${table.notes}, '') !~ '[0-9]{13,}'
        AND coalesce(${table.menuNotes}, '') !~ '[0-9]{13,}' AND coalesce(${table.depositReference}, '') !~ '[0-9]{13,}'`,
    ),
    index("event_bookings_location_starts_idx").on(table.locationId, table.startsAt),
    index("event_bookings_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

/** A TABLES event's chosen tables. Replaced as a whole while the event is open. */
export const eventBookingTables = pgTable(
  "event_booking_tables",
  {
    eventBookingId: uuid("event_booking_id").notNull(),
    restaurantTableId: uuid("restaurant_table_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "event_booking_tables_pk", columns: [table.eventBookingId, table.restaurantTableId] }),
    foreignKey({
      name: "event_booking_tables_event_fk",
      columns: [table.eventBookingId],
      foreignColumns: [eventBookings.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_booking_tables_table_fk",
      columns: [table.restaurantTableId],
      foreignColumns: [restaurantTables.id],
    }).onDelete("restrict"),
    index("event_booking_tables_table_idx").on(table.restaurantTableId),
  ],
);
