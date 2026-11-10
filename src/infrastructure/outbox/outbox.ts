import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { outboxEvents } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeLog } from "@/infrastructure/logging/logger";

import { isDeadLetter, retryDelayMs } from "./outbox-policy";

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

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 10;

export type ProcessOutboxOptions = {
  limit?: number;
  /** For tests with a controlled clock. */
  now?: Date;
  maxAttempts?: number;
};

/**
 * Publishes one batch of committed events that are due. Rows are claimed with SKIP LOCKED,
 * so two processors never publish the same event. A publisher failure records the attempt
 * and its error name and backs the event off (1 s, doubling, capped at 5 min); at the
 * maximum attempts it is dead-lettered and never claimed again automatically. Events only
 * mean "refetch", so a backed-off or dead-lettered event never blocks later ones. Returns
 * how many events were published.
 */
export async function processOutboxBatch(
  database: Database,
  publish: OutboxPublisher,
  options: ProcessOutboxOptions = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;

  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.publishedAt),
          isNull(outboxEvents.failedAt),
          or(isNull(outboxEvents.nextAttemptAt), lte(outboxEvents.nextAttemptAt, now)),
        ),
      )
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
        const attempts = row.attempts + 1;
        const deadLetter = isDeadLetter(attempts, maxAttempts);

        await transaction
          .update(outboxEvents)
          .set({
            attempts,
            lastError: message.slice(0, MAX_ERROR_LENGTH),
            nextAttemptAt: deadLetter ? null : new Date(now.getTime() + retryDelayMs(attempts)),
            failedAt: deadLetter ? now : null,
          })
          .where(eq(outboxEvents.id, row.id));

        if (deadLetter) {
          // Logged once, when it happens. Identifiers only: never the payload.
          writeLog({
            severity: "error",
            module: "outbox",
            operation: "dead-letter",
            message: `Outbox event dead-lettered after ${attempts} attempts (${row.eventType} on ${row.aggregateType} ${row.aggregateId}).`,
            entityId: row.id,
            errorName: message.slice(0, MAX_ERROR_LENGTH),
          });
        }
      }
    }

    if (published.length > 0) {
      await transaction
        .update(outboxEvents)
        .set({ publishedAt: now, nextAttemptAt: null, attempts: sql`${outboxEvents.attempts} + 1` })
        .where(inArray(outboxEvents.id, published));
    }

    return published.length;
  });
}
