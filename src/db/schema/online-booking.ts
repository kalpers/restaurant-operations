import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, time, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations } from "./organization";

// Phase 22 online booking (policies 7 and 10). Owned by Reservations. A location without a
// settings row has online booking off and the default reminder time.

export const ONLINE_SLOT_INTERVALS = [15, 30, 60] as const;

export const onlineBookingSettings = pgTable(
  "online_booking_settings",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    maxPartySize: integer("max_party_size").notNull().default(6),
    minLeadMinutes: integer("min_lead_minutes").notNull().default(120),
    maxDaysAhead: integer("max_days_ahead").notNull().default(30),
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    maxCoversPerSlot: integer("max_covers_per_slot").notNull().default(20),
    /** 0 turns reminders off. Applies to every confirmed reservation, not only online ones. */
    reminderHoursBefore: integer("reminder_hours_before").notNull().default(24),
    publicNote: text("public_note"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("online_booking_settings_location_id_unique").on(table.locationId),
    check("online_booking_settings_party_size_valid", sql`${table.maxPartySize} BETWEEN 1 AND 50`),
    check("online_booking_settings_lead_valid", sql`${table.minLeadMinutes} BETWEEN 0 AND 10080`),
    check("online_booking_settings_days_ahead_valid", sql`${table.maxDaysAhead} BETWEEN 1 AND 365`),
    check("online_booking_settings_interval_valid", sql`${table.slotIntervalMinutes} IN (15, 30, 60)`),
    check("online_booking_settings_covers_valid", sql`${table.maxCoversPerSlot} BETWEEN 1 AND 1000`),
    check("online_booking_settings_reminder_valid", sql`${table.reminderHoursBefore} BETWEEN 0 AND 168`),
    check(
      "online_booking_settings_public_note_valid",
      sql`${table.publicNote} IS NULL OR (length(${table.publicNote}) <= 500 AND ${table.publicNote} !~ '[0-9]{13,}')`,
    ),
  ],
);

/** When online bookings may start, per weekday (0 Sunday to 6 Saturday), in local time. */
export const onlineBookingPeriods = pgTable(
  "online_booking_periods",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    weekday: integer("weekday").notNull(),
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("online_booking_periods_weekday_valid", sql`${table.weekday} BETWEEN 0 AND 6`),
    check("online_booking_periods_order_valid", sql`${table.endsAt} > ${table.startsAt}`),
    index("online_booking_periods_location_weekday_idx").on(table.locationId, table.weekday),
  ],
);

/**
 * Public request throttling (policy 10): a fixed window per key, an HMAC of a client IP or a
 * normalized contact, never the value. Counted with one atomic upsert per attempt.
 */
export const publicThrottles = pgTable(
  "public_throttles",
  {
    keyHash: text("key_hash").primaryKey(),
    attempts: integer("attempts").notNull(),
    windowStartedAt: timestamptz("window_started_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("public_throttles_attempts_positive", sql`${table.attempts} > 0`),
    check("public_throttles_key_hash_format", sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
