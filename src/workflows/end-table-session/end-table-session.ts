import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { countOpenOrdersForSession } from "@/modules/orders/repositories/order-repository";
import {
  markPartyCompleted,
  revertPartySeating,
} from "@/modules/reservations/services/party-state";
import {
  cancelSessionInTransaction,
  completeSessionInTransaction,
} from "@/modules/restaurant/services/session-service";
import { readConstraintName } from "@/db/helpers/database-errors";
import { BusinessRuleError } from "@/shared/errors/app-error";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

type Versioned = { id: string; version: number };

/**
 * A session can't end while any of its orders is OPEN. The session is already locked FOR
 * UPDATE by the Restaurant domain here, and order creation locks it FOR SHARE, so an order
 * being opened at the same moment is either seen or refused, never missed. Phase 9 never
 * closes an order to make this pass; Phase 11 settlement does.
 */
function ordersOpenError() {
  return new BusinessRuleError(
    "ORDERS_OPEN",
    "This table still has an open order. Settle or void it before ending the session.",
  );
}

async function assertNoOpenOrders(transaction: DatabaseTransaction, sessionId: string) {
  if ((await countOpenOrdersForSession(transaction, sessionId)) > 0) {
    throw ordersOpenError();
  }
}

/** The database trigger is the final guard, for any path that ends a session. */
async function mapOpenOrders<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (readConstraintName(error) === "table_sessions_orders_open") {
      throw ordersOpenError();
    }

    throw error;
  }
}

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
  return mapOpenOrders(() => withTransaction(database, async (transaction) => {
    const ended = await completeSessionInTransaction(
      transaction,
      actor,
      sessionId,
      input,
    );

    await assertNoOpenOrders(transaction, sessionId);

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
  }));
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
  return mapOpenOrders(() => withTransaction(database, async (transaction) => {
    const ended = await cancelSessionInTransaction(
      transaction,
      actor,
      sessionId,
      input,
    );

    await assertNoOpenOrders(transaction, sessionId);

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
  }));
}
