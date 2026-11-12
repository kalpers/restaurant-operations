import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { users } from "./auth";
import { guestParties } from "./guest-parties";
import { locations, organizations } from "./organization";
import { reservations, waitlistEntries } from "./reservations";

// Phase 22 guest messaging (policies 2-4). Owned by Reservations. A message is queued in the
// transaction of the change it reports and sent by the dispatcher after commit, outside any
// transaction (D2). Addresses and bodies may only be cleared (erase and retention, D14).

export const GUEST_MESSAGE_KINDS = [
  "RESERVATION_CONFIRMED",
  "RESERVATION_RECEIVED",
  "RESERVATION_CHANGED",
  "RESERVATION_CANCELLED",
  "RESERVATION_REMINDER",
  "WAITLIST_TABLE_READY",
] as const;
export type GuestMessageKind = (typeof GUEST_MESSAGE_KINDS)[number];
export const GUEST_MESSAGE_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SUPPRESSED", "CANCELLED"] as const;
export type GuestMessageStatus = (typeof GUEST_MESSAGE_STATUSES)[number];
export const SUPPRESSION_REASONS = ["UNSUBSCRIBED", "PROVIDER_OPT_OUT", "STAFF"] as const;
export const CONSENT_SOURCES = ["ONLINE_FORM", "STAFF_RECORDED"] as const;
export const CONSENT_WITHDRAW_REASONS = ["STAFF", "ADDRESS_CHANGED", "UNSUBSCRIBED", "PROVIDER_OPT_OUT", "ERASED"] as const;

export const guestMessages = pgTable(
  "guest_messages",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    guestPartyId: uuid("guest_party_id")
      .notNull()
      .references(() => guestParties.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id").references(() => reservations.id, { onDelete: "restrict" }),
    waitlistEntryId: uuid("waitlist_entry_id").references(() => waitlistEntries.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    /** As sent. Cleared by erase and retention. */
    recipientAddress: text("recipient_address"),
    subject: text("subject"),
    body: text("body"),
    /** Email only: SHA-256 of the one-click unsubscribe token in the body. */
    unsubscribeTokenHash: text("unsubscribe_token_hash"),
    /** At most one message per trigger (D3), e.g. `reservation:{id}:confirmed:v2:EMAIL`. */
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    /** Not sent before this instant (quiet hours, D15). */
    sendAfter: timestamptz("send_after").notNull().defaultNow(),
    /** After a transient failure: not claimed again before this instant. */
    nextAttemptAt: timestamptz("next_attempt_at"),
    /** Set while SENDING, so a crashed send is recovered (D3). */
    claimedAt: timestamptz("claimed_at"),
    /** Error kind and provider code only. */
    lastErrorCode: text("last_error_code"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamptz("sent_at"),
    failedAt: timestamptz("failed_at"),
    suppressedAt: timestamptz("suppressed_at"),
    cancelledAt: timestamptz("cancelled_at"),
    /** Address, subject and body cleared by erase or retention. */
    erasedAt: timestamptz("erased_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("guest_messages_dedupe_key_unique").on(table.dedupeKey),
    check(
      "guest_messages_kind_valid",
      sql`${table.kind} IN ('RESERVATION_CONFIRMED', 'RESERVATION_RECEIVED', 'RESERVATION_CHANGED', 'RESERVATION_CANCELLED', 'RESERVATION_REMINDER', 'WAITLIST_TABLE_READY')`,
    ),
    check("guest_messages_channel_valid", sql`${table.channel} IN ('EMAIL', 'SMS')`),
    check(
      "guest_messages_status_valid",
      sql`${table.status} IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED')`,
    ),
    check(
      "guest_messages_one_subject",
      sql`num_nonnulls(${table.reservationId}, ${table.waitlistEntryId}) = 1`,
    ),
    check(
      "guest_messages_kind_matches_subject",
      sql`(${table.kind} = 'WAITLIST_TABLE_READY') = (${table.waitlistEntryId} IS NOT NULL)`,
    ),
    check(
      "guest_messages_subject_line_email_only",
      sql`${table.channel} = 'EMAIL' OR (${table.subject} IS NULL AND ${table.unsubscribeTokenHash} IS NULL)`,
    ),
    check(
      "guest_messages_content",
      sql`CASE WHEN ${table.erasedAt} IS NULL
        THEN ${table.recipientAddress} IS NOT NULL AND ${table.body} IS NOT NULL
        ELSE ${table.recipientAddress} IS NULL AND ${table.subject} IS NULL AND ${table.body} IS NULL END`,
    ),
    check(
      "guest_messages_not_sendable_when_erased",
      sql`${table.erasedAt} IS NULL OR ${table.status} NOT IN ('QUEUED', 'SENDING')`,
    ),
    check("guest_messages_attempts_non_negative", sql`${table.attempts} >= 0`),
    check("guest_messages_sending_claimed", sql`(${table.status} = 'SENDING') = (${table.claimedAt} IS NOT NULL)`),
    check("guest_messages_sent_metadata", sql`(${table.status} = 'SENT') = (${table.sentAt} IS NOT NULL)`),
    check("guest_messages_failed_metadata", sql`(${table.status} = 'FAILED') = (${table.failedAt} IS NOT NULL)`),
    check(
      "guest_messages_suppressed_metadata",
      sql`(${table.status} = 'SUPPRESSED') = (${table.suppressedAt} IS NOT NULL)`,
    ),
    check(
      "guest_messages_cancelled_metadata",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)`,
    ),
    check(
      "guest_messages_error_code_valid",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[A-Za-z0-9_.:-]{1,60}$'`,
    ),
    index("guest_messages_due_idx")
      .on(table.sendAfter, table.nextAttemptAt)
      .where(sql`${table.status} = 'QUEUED'`),
    index("guest_messages_sending_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'SENDING'`),
    index("guest_messages_failed_idx")
      .on(table.organizationId, table.failedAt)
      .where(sql`${table.status} = 'FAILED'`),
    index("guest_messages_retention_idx")
      .on(table.createdAt)
      .where(sql`${table.erasedAt} IS NULL`),
    index("guest_messages_reservation_id_idx").on(table.reservationId),
    index("guest_messages_waitlist_entry_id_idx").on(table.waitlistEntryId),
    index("guest_messages_guest_party_id_idx").on(table.guestPartyId),
    index("guest_messages_unsubscribe_token_hash_idx")
      .on(table.unsubscribeTokenHash)
      .where(sql`${table.unsubscribeTokenHash} IS NOT NULL`),
  ],
);

/**
 * The opt-out list (D6, policy 4): an HMAC of the channel and normalized address, so an
 * opted-out guest is never messaged again, even after erase, without keeping the address.
 * Append-only.
 */
export const messageSuppressions = pgTable(
  "message_suppressions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channel: text("channel").notNull(),
    addressHash: text("address_hash").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("message_suppressions_org_channel_hash_unique").on(table.organizationId, table.channel, table.addressHash),
    check("message_suppressions_channel_valid", sql`${table.channel} IN ('EMAIL', 'SMS')`),
    check(
      "message_suppressions_reason_valid",
      sql`${table.reason} IN ('UNSUBSCRIBED', 'PROVIDER_OPT_OUT', 'STAFF')`,
    ),
    check("message_suppressions_hash_format", sql`${table.addressHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Consent to service messages on one channel for one visit (D5, policy 5). No consent, no
 * message. Withdrawn once and never re-opened: consenting again adds a row. Erase clears the
 * address (D14).
 */
export const guestPartyMessageConsents = pgTable(
  "guest_party_message_consents",
  {
    id: uuidPrimaryKey(),
    guestPartyId: uuid("guest_party_id").notNull(),
    channel: text("channel").notNull(),
    /** E.164 for SMS, normalized email for EMAIL. Null only once erased. */
    address: text("address"),
    grantedAt: timestamptz("granted_at").notNull(),
    source: text("source").notNull(),
    /** Null for ONLINE_FORM: the guest gave it on the public page. */
    grantedByUserId: uuid("granted_by_user_id"),
    withdrawnAt: timestamptz("withdrawn_at"),
    withdrawnByUserId: uuid("withdrawn_by_user_id"),
    withdrawReason: text("withdraw_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    // Named by hand: the generated names pass PostgreSQL's 63-character limit.
    foreignKey({
      name: "message_consents_guest_party_fk",
      columns: [table.guestPartyId],
      foreignColumns: [guestParties.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "message_consents_granted_by_user_fk",
      columns: [table.grantedByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "message_consents_withdrawn_by_user_fk",
      columns: [table.withdrawnByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    uniqueIndex("guest_party_message_consents_one_active")
      .on(table.guestPartyId, table.channel)
      .where(sql`${table.withdrawnAt} IS NULL`),
    check("guest_party_message_consents_channel_valid", sql`${table.channel} IN ('EMAIL', 'SMS')`),
    check(
      "guest_party_message_consents_source_valid",
      sql`${table.source} IN ('ONLINE_FORM', 'STAFF_RECORDED')`,
    ),
    check(
      "guest_party_message_consents_granted_by",
      sql`(${table.source} = 'STAFF_RECORDED') = (${table.grantedByUserId} IS NOT NULL)`,
    ),
    check(
      "guest_party_message_consents_withdrawn_metadata",
      sql`(${table.withdrawnAt} IS NULL) = (${table.withdrawReason} IS NULL)
        AND (${table.withdrawnByUserId} IS NULL OR ${table.withdrawnAt} IS NOT NULL)`,
    ),
    check(
      "guest_party_message_consents_withdraw_reason_valid",
      sql`${table.withdrawReason} IS NULL OR ${table.withdrawReason} IN ('STAFF', 'ADDRESS_CHANGED', 'UNSUBSCRIBED', 'PROVIDER_OPT_OUT', 'ERASED')`,
    ),
    check(
      "guest_party_message_consents_address",
      sql`(${table.address} IS NOT NULL OR ${table.withdrawnAt} IS NOT NULL)
        AND (${table.address} IS NULL OR (${table.channel} = 'SMS' AND ${table.address} ~ '^[+][1-9][0-9]{6,14}$')
          OR (${table.channel} = 'EMAIL' AND length(${table.address}) <= 254))`,
    ),
  ],
);

/**
 * The guest's private link to view or cancel a reservation (D11, policy 11). Only the SHA-256
 * of the token is kept; the token itself travels only in the message or the booking reply.
 */
export const reservationManageLinks = pgTable(
  "reservation_manage_links",
  {
    id: uuidPrimaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    /** When maintenance may delete the row. Whether the link works is decided on use. */
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    unique("reservation_manage_links_token_hash_unique").on(table.tokenHash),
    check("reservation_manage_links_token_hash_format", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    index("reservation_manage_links_reservation_id_idx").on(table.reservationId),
    index("reservation_manage_links_expires_at_idx").on(table.expiresAt),
  ],
);
