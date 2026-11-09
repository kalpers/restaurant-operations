import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz } from "../helpers/timestamps";
import { users } from "./auth";
import { locations, organizations } from "./organization";

/**
 * Client idempotency keys for critical retryable commands (README section 23). A row is
 * claimed in the same transaction as the command and holds its response, so a retry of
 * a committed command returns the first outcome and a rolled-back attempt leaves no row.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** The command, for example `orders.send`. */
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** SHA-256 of the canonical request, so a reused key with another request is refused. */
    requestFingerprint: text("request_fingerprint").notNull(),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("idempotency_records_org_scope_key_unique").on(
      table.organizationId,
      table.scope,
      table.idempotencyKey,
    ),
  ],
);

/**
 * Transactional outbox (README section 23). A row is written inside the transaction that
 * makes the change, so it exists only if that change committed. The outbox processor
 * publishes unpublished rows to the realtime adapter after commit and marks them. Payloads
 * carry identifiers only: no prices, costs, guest contact or HR data.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuidPrimaryKey(),
    /** Insert order, for publishing in sequence. Not a commit order. */
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    /** `domain.event-name`, for example `kitchen.item-ready`. */
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    /** Set for events meant for one user only, such as a notification. */
    recipientUserId: uuid("recipient_user_id").references(() => users.id, { onDelete: "restrict" }),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
    publishedAt: timestamptz("published_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    unique("outbox_events_sequence_unique").on(table.sequence),
    check("outbox_events_event_type_format", sql`${table.eventType} ~ '^[a-z]+[.][a-z-]+$'`),
    check("outbox_events_attempts_non_negative", sql`${table.attempts} >= 0`),
    index("outbox_events_unpublished_idx")
      .on(table.sequence)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);
