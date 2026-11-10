import { and, count, desc, eq, isNotNull, isNull, min } from "drizzle-orm";

import { outboxEvents } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";

// Read and requeue functions for the System health page (Phase 16 policy 14). Payloads are
// never selected, so no caller can expose one. Authorization and audit belong to the caller.

export const DEAD_LETTER_LIST_LIMIT = 50;

export type DeadLetteredEvent = {
  id: string;
  sequence: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  occurredAt: Date;
  createdAt: Date;
  failedAt: Date;
};

export type OutboxHealth = {
  unpublishedCount: number;
  /** Seconds since the oldest unpublished, non-dead-lettered event was written. */
  oldestUnpublishedAgeSeconds: number | null;
  deadLetteredCount: number;
  deadLettered: DeadLetteredEvent[];
};

export async function getOutboxHealth(
  executor: DatabaseExecutor,
  organizationId: string,
  now: Date = new Date(),
): Promise<OutboxHealth> {
  const [pending] = await executor
    .select({ total: count(), oldest: min(outboxEvents.createdAt) })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, organizationId),
        isNull(outboxEvents.publishedAt),
        isNull(outboxEvents.failedAt),
      ),
    );
  const [dead] = await executor
    .select({ total: count() })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.organizationId, organizationId), isNotNull(outboxEvents.failedAt)));
  const rows = await executor
    .select({
      id: outboxEvents.id,
      sequence: outboxEvents.sequence,
      eventType: outboxEvents.eventType,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      attempts: outboxEvents.attempts,
      lastError: outboxEvents.lastError,
      occurredAt: outboxEvents.occurredAt,
      createdAt: outboxEvents.createdAt,
      failedAt: outboxEvents.failedAt,
    })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.organizationId, organizationId), isNotNull(outboxEvents.failedAt)))
    .orderBy(desc(outboxEvents.failedAt), desc(outboxEvents.sequence))
    .limit(DEAD_LETTER_LIST_LIMIT);
  const oldest = pending?.oldest ? new Date(pending.oldest) : null;

  return {
    unpublishedCount: pending?.total ?? 0,
    oldestUnpublishedAgeSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null,
    deadLetteredCount: dead?.total ?? 0,
    deadLettered: rows.map((row) => ({ ...row, failedAt: row.failedAt! })),
  };
}

/**
 * Requeues one dead-lettered event of this organization: clears `failed_at` and
 * `next_attempt_at` and resets `attempts` to 0. Returns the event as it was, or undefined
 * when there is no such dead-lettered event.
 */
export async function requeueDeadLetteredEvent(
  transaction: DatabaseTransaction,
  organizationId: string,
  eventId: string,
): Promise<{ id: string; eventType: string; aggregateType: string; attempts: number } | undefined> {
  const [current] = await transaction
    .select({
      id: outboxEvents.id,
      eventType: outboxEvents.eventType,
      aggregateType: outboxEvents.aggregateType,
      attempts: outboxEvents.attempts,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.id, eventId),
        eq(outboxEvents.organizationId, organizationId),
        isNotNull(outboxEvents.failedAt),
      ),
    )
    .for("update");

  if (!current) {
    return undefined;
  }

  await transaction
    .update(outboxEvents)
    .set({ failedAt: null, nextAttemptAt: null, attempts: 0 })
    .where(eq(outboxEvents.id, eventId));

  return current;
}
