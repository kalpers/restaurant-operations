import { asc, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { outboxEvents } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

// Transactional outbox (README sections 3, 23 and 24). Domains write events inside the
// transaction that makes the change, so an event exists only if its change committed. The
// processor publishes committed, unpublished events in sequence and marks them published.
// Nothing is sent to a browser from inside a transaction.

export type OutboxEventInput = {
  organizationId: string;
  locationId: string | null;
  /** `domain.event-name`, e.g. `kitchen.item-ready`. */
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  /** For events only one user may see, such as a notification. */
  recipientUserId?: string | null;
  /** Identifiers only: no prices, costs, guest contact or HR data. */
  payload: Record<string, string | number | boolean | null | readonly string[]>;
  occurredAt: Date;
};

export type PublishedEvent = {
  id: string;
  sequence: number;
  organizationId: string;
  locationId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  recipientUserId: string | null;
  payload: unknown;
  occurredAt: string;
};

export type OutboxPublisher = (event: PublishedEvent) => void | Promise<void>;

export async function writeOutboxEvents(
  transaction: DatabaseTransaction,
  events: readonly OutboxEventInput[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await transaction.insert(outboxEvents).values(
    events.map((event) => ({
      organizationId: event.organizationId,
      locationId: event.locationId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      recipientUserId: event.recipientUserId ?? null,
      payload: event.payload,
      occurredAt: event.occurredAt,
    })),
  );
}

const MAX_ERROR_LENGTH = 500;

/**
 * Publishes one batch of committed events. Rows are claimed with SKIP LOCKED, so two
 * processors never publish the same event. A publisher failure leaves the event unpublished
 * with its attempt count and error, and it is retried on the next batch. Returns how many
 * events were published.
 */
export async function processOutboxBatch(
  database: Database,
  publish: OutboxPublisher,
  limit = 100,
): Promise<number> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.sequence))
      .limit(limit)
      .for("update", { skipLocked: true });

    const published: string[] = [];

    for (const row of rows) {
      try {
        await publish({
          id: row.id,
          sequence: row.sequence,
          organizationId: row.organizationId,
          locationId: row.locationId,
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          recipientUserId: row.recipientUserId,
          payload: row.payload,
          occurredAt: row.occurredAt.toISOString(),
        });
        published.push(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.name : "PublishError";

        await transaction
          .update(outboxEvents)
          .set({
            attempts: sql`${outboxEvents.attempts} + 1`,
            lastError: message.slice(0, MAX_ERROR_LENGTH),
          })
          .where(inArray(outboxEvents.id, [row.id]));
      }
    }

    if (published.length > 0) {
      await transaction
        .update(outboxEvents)
        .set({ publishedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` })
        .where(inArray(outboxEvents.id, published));
    }

    return published.length;
  });
}
