import type { Database } from "@/db";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import {
  getOutboxHealth,
  requeueDeadLetteredEvent,
  type OutboxHealth,
} from "@/infrastructure/outbox/outbox-health";
import { getGuestMessageHealth, type GuestMessageHealth } from "@/infrastructure/messaging/message-health";
import { recordAudit } from "@/modules/auditing";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

import type { Actor } from "../types";

// Admin → System health (Phase 16 policy 14). Lives in the auth module because it owns the
// `admin.*` permissions; the outbox data functions stay in infrastructure. Outbox rows are
// organization-wide, so an actor sees their own organization's events.

function assertHolds(actor: Actor, permission: "admin.system.view" | "admin.system.manage"): void {
  if (!actor.permissions.has(permission)) {
    throw new AuthorizationError();
  }
}

export type SystemHealth = OutboxHealth & { guestMessages: GuestMessageHealth };

/**
 * Counts and the 50 most recent dead-lettered events, plus guest message counts (Phase 22).
 * Never a payload, address or message body.
 */
export function getSystemHealth(executor: DatabaseExecutor, actor: Actor, now: Date = new Date()): Promise<SystemHealth> {
  assertHolds(actor, "admin.system.view");

  return Promise.all([
    getOutboxHealth(executor, actor.organizationId, now),
    getGuestMessageHealth(executor, actor.organizationId),
  ]).then(([outbox, guestMessages]) => ({ ...outbox, guestMessages }));
}

/** Requeues a dead-lettered event and records `system.outbox-event-retried` atomically. */
export async function retryDeadLetteredEvent(
  database: Database,
  actor: Actor,
  eventId: string,
): Promise<{ id: string; requeued: true }> {
  assertHolds(actor, "admin.system.manage");

  return withTransaction(database, async (transaction) => {
    const event = await requeueDeadLetteredEvent(transaction, actor.organizationId, eventId);

    if (!event) {
      throw new NotFoundError("dead-lettered event");
    }

    await recordAudit(transaction, actor, {
      action: "system.outbox-event-retried",
      entityId: event.id,
      before: { eventType: event.eventType, aggregateType: event.aggregateType, attempts: event.attempts },
      after: { attempts: 0 },
    });

    return { id: event.id, requeued: true };
  });
}
