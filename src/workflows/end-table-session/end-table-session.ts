import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  markPartyCompleted,
  revertPartySeating,
} from "@/modules/reservations/services/party-state";
import {
  cancelSessionInTransaction,
  completeSessionInTransaction,
} from "@/modules/restaurant/services/session-service";

type Versioned = { id: string; version: number };

/**
 * Completes a session and, in the same transaction, finishes the visit of the Guest Party
 * and reservation seated in it. The Restaurant domain still owns the session; this
 * workflow only orchestrates, so there is no trigger between the two domains.
 */
export async function completeTableSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  return withTransaction(database, async (transaction) => {
    const ended = await completeSessionInTransaction(
      transaction,
      actor,
      sessionId,
      input,
    );

    if (ended.guestPartyId) {
      await markPartyCompleted(
        transaction,
        actor,
        actor.locationId,
        ended.guestPartyId,
        new Date(),
      );
    }

    return { id: ended.id, version: ended.version };
  });
}

/**
 * Cancels a mistaken seating and puts the Guest Party back where it was: checked in, or
 * waiting. The reservation or waitlist entry is restored with it, and history is kept.
 */
export async function cancelTableSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { reason: string; expectedVersion: number },
): Promise<Versioned> {
  return withTransaction(database, async (transaction) => {
    const ended = await cancelSessionInTransaction(
      transaction,
      actor,
      sessionId,
      input,
    );

    if (ended.guestPartyId) {
      await revertPartySeating(
        transaction,
        actor,
        actor.locationId,
        ended.guestPartyId,
        new Date(),
      );
    }

    return { id: ended.id, version: ended.version };
  });
}
