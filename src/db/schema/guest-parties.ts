import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { allergens } from "./allergens";
import { users } from "./auth";
import { locations, organizations } from "./organization";

// A Guest Party is the group being served. Its contact fields run this visit's reservation or
// waitlist entry. Phase 21 adds guest profiles: a guest known across visits, which a party may
// link to (`guest_profile_id`). Linking copies nothing between them (policy 2).

export const GUEST_PROFILE_STATUSES = ["ACTIVE", "MERGED", "ERASED"] as const;
export const ALLERGY_SEVERITIES = ["SEVERE", "ALLERGY"] as const;

/** One counter per organization for human-readable profile numbers. */
export const guestProfileNumberCounters = pgTable(
  "guest_profile_number_counters",
  {
    organizationId: uuid("organization_id").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    // Named explicitly: the generated name exceeds PostgreSQL's 63-character limit.
    foreignKey({
      name: "guest_profile_number_counters_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("guest_profile_number_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

/** No 13 or more digits in a row in free text: the card-safety rule (CLAUDE.md rule 15). */
const noCardDigits = (column: unknown) => sql`(${column} IS NULL OR ${column} !~ '[0-9]{13,}')`;

/**
 * Phase 21 guest profile (policies 1-5), organization-wide. Phone and email are optional and
 * not unique; their normalized forms serve lookups. MERGED and ERASED profiles are frozen by
 * a guard trigger (migration 0050).
 */
export const guestProfiles = pgTable(
  "guest_profiles",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    profileNumber: integer("profile_number").notNull(),
    displayName: text("display_name").notNull(),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    vip: boolean("vip").notNull().default(false),
    vipReason: text("vip_reason"),
    preferences: text("preferences"),
    notes: text("notes"),
    otherDietaryNeeds: text("other_dietary_needs"),
    status: text("status").notNull().default("ACTIVE"),
    mergedIntoProfileId: uuid("merged_into_profile_id"),
    erasedAt: timestamptz("erased_at"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("guest_profiles_organization_id_profile_number_unique").on(table.organizationId, table.profileNumber),
    unique("guest_profiles_id_organization_id_unique").on(table.id, table.organizationId),
    foreignKey({
      name: "guest_profiles_merged_into_fk",
      columns: [table.mergedIntoProfileId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete("restrict"),
    check("guest_profiles_status_valid", sql`${table.status} IN ('ACTIVE', 'MERGED', 'ERASED')`),
    check("guest_profiles_profile_number_positive", sql`${table.profileNumber} > 0`),
    check("guest_profiles_display_name_valid", sql`length(trim(${table.displayName})) BETWEEN 1 AND 120`),
    check(
      "guest_profiles_text_lengths",
      sql`(${table.phone} IS NULL OR length(${table.phone}) <= 40)
        AND (${table.email} IS NULL OR length(${table.email}) <= 254)
        AND (${table.vipReason} IS NULL OR length(${table.vipReason}) <= 200)
        AND (${table.preferences} IS NULL OR length(${table.preferences}) <= 500)
        AND (${table.notes} IS NULL OR length(${table.notes}) <= 1000)
        AND (${table.otherDietaryNeeds} IS NULL OR length(${table.otherDietaryNeeds}) <= 500)`,
    ),
    check(
      "guest_profiles_phone_normalized_format",
      sql`${table.phoneNormalized} IS NULL OR ${table.phoneNormalized} ~ '^[+]?[0-9]{3,15}$'`,
    ),
    check(
      "guest_profiles_no_card_digits",
      sql`${noCardDigits(table.email)} AND ${noCardDigits(table.vipReason)} AND ${noCardDigits(table.preferences)}
        AND ${noCardDigits(table.notes)} AND ${noCardDigits(table.otherDietaryNeeds)}`,
    ),
    check(
      "guest_profiles_merge_consistent",
      sql`(${table.status} = 'MERGED') = (${table.mergedIntoProfileId} IS NOT NULL)
        AND (${table.mergedIntoProfileId} IS NULL OR ${table.mergedIntoProfileId} <> ${table.id})`,
    ),
    // An ERASED profile has an erase time; a MERGED one may too, when the profile it was
    // merged into is erased (amendment 4). An ACTIVE one never does.
    check(
      "guest_profiles_erase_consistent",
      sql`(${table.status} <> 'ERASED' OR ${table.erasedAt} IS NOT NULL) AND (${table.status} <> 'ACTIVE' OR ${table.erasedAt} IS NULL)`,
    ),
    index("guest_profiles_org_phone_idx").on(table.organizationId, table.phoneNormalized),
    index("guest_profiles_org_email_idx").on(table.organizationId, table.emailNormalized),
  ],
);

/** A profile's known allergies (policy 7). Editing a profile replaces them. */
export const guestProfileAllergies = pgTable(
  "guest_profile_allergies",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    guestProfileId: uuid("guest_profile_id").notNull(),
    allergenId: uuid("allergen_id").notNull(),
    severity: text("severity").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_profile_allergies_profile_org_fk",
      columns: [table.guestProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_profile_allergies_allergen_org_fk",
      columns: [table.allergenId, table.organizationId],
      foreignColumns: [allergens.id, allergens.organizationId],
    }).onDelete("restrict"),
    unique("guest_profile_allergies_profile_allergen_unique").on(table.guestProfileId, table.allergenId),
    check("guest_profile_allergies_severity_valid", sql`${table.severity} IN ('SEVERE', 'ALLERGY')`),
    check(
      "guest_profile_allergies_note_valid",
      sql`${table.note} IS NULL OR (length(${table.note}) <= 200 AND ${table.note} !~ '[0-9]{13,}')`,
    ),
  ],
);

/** Append-only record of one profile merged into another (policy 3). */
export const guestProfileMerges = pgTable(
  "guest_profile_merges",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    mergedProfileId: uuid("merged_profile_id").notNull(),
    keptProfileId: uuid("kept_profile_id").notNull(),
    partiesMoved: integer("parties_moved").notNull(),
    allergiesAdded: integer("allergies_added").notNull(),
    reason: text("reason").notNull(),
    mergedByUserId: uuid("merged_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    mergedAt: timestamptz("merged_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_profile_merges_merged_fk",
      columns: [table.mergedProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_profile_merges_kept_fk",
      columns: [table.keptProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    unique("guest_profile_merges_merged_unique").on(table.mergedProfileId),
    check("guest_profile_merges_distinct", sql`${table.mergedProfileId} <> ${table.keptProfileId}`),
    check("guest_profile_merges_counts", sql`${table.partiesMoved} >= 0 AND ${table.allergiesAdded} >= 0`),
    check("guest_profile_merges_reason_valid", sql`length(trim(${table.reason})) BETWEEN 1 AND 200`),
  ],
);

/** The group of guests, from expected arrival through to their visit being completed. */
export const guestParties = pgTable(
  "guest_parties",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    partySize: integer("party_size").notNull(),
    guestName: text("guest_name").notNull(),
    phone: text("phone"),
    email: text("email"),
    specialRequests: text("special_requests"),
    status: text("status").notNull(),
    /** Phase 21 (policy 2): the guest profile this visit belongs to, linked by hand. */
    guestProfileId: uuid("guest_profile_id").references(() => guestProfiles.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("guest_parties_id_location_id_unique").on(table.id, table.locationId),
    check("guest_parties_party_size_positive", sql`${table.partySize} > 0`),
    check(
      "guest_parties_guest_name_not_blank",
      sql`length(trim(${table.guestName})) > 0`,
    ),
    check(
      "guest_parties_status_valid",
      sql`${table.status} IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    ),
    index("guest_parties_location_id_status_idx").on(
      table.locationId,
      table.status,
    ),
    index("guest_parties_guest_profile_id_idx").on(table.guestProfileId),
  ],
);

/**
 * Phase 21 (policy 8): this visit's allergies, which the order warning checks. PROFILE rows
 * come from the linked profile and leave with it; RECORDED rows were added for this visit.
 */
export const guestPartyAllergies = pgTable(
  "guest_party_allergies",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    guestPartyId: uuid("guest_party_id")
      .notNull()
      .references(() => guestParties.id, { onDelete: "restrict" }),
    allergenId: uuid("allergen_id").notNull(),
    severity: text("severity").notNull(),
    note: text("note"),
    source: text("source").notNull(),
    /** Phase 22 (D10): null only for an ONLINE allergy, given by the guest when booking. */
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamptz("recorded_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_party_allergies_allergen_org_fk",
      columns: [table.allergenId, table.organizationId],
      foreignColumns: [allergens.id, allergens.organizationId],
    }).onDelete("restrict"),
    unique("guest_party_allergies_party_allergen_unique").on(table.guestPartyId, table.allergenId),
    check("guest_party_allergies_severity_valid", sql`${table.severity} IN ('SEVERE', 'ALLERGY')`),
    check("guest_party_allergies_source_valid", sql`${table.source} IN ('PROFILE', 'RECORDED', 'ONLINE')`),
    check(
      "guest_party_allergies_recorded_by_online_only",
      sql`(${table.recordedByUserId} IS NULL) = (${table.source} = 'ONLINE')`,
    ),
    check(
      "guest_party_allergies_note_valid",
      sql`${table.note} IS NULL OR (length(${table.note}) <= 200 AND ${table.note} !~ '[0-9]{13,}')`,
    ),
  ],
);

/** Append-only domain history of a party's status. It isn't the audit domain. */
export const partyStatusHistory = pgTable(
  "party_status_history",
  {
    id: uuidPrimaryKey(),
    guestPartyId: uuid("guest_party_id")
      .notNull()
      .references(() => guestParties.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "party_status_history_status_valid",
      sql`${table.status} IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    ),
    index("party_status_history_guest_party_id_occurred_at_idx").on(
      table.guestPartyId,
      table.occurredAt,
    ),
  ],
);
