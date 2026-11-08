import { and, eq, inArray } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  guestParties,
  partyStatusHistory,
  reservations,
  waitlistEntries,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { NotFoundError } from "@/shared/errors/app-error";

import type { GuestPartyStatus } from "../types";

export type PartyRow = typeof guestParties.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type WaitlistRow = typeof waitlistEntries.$inferSelect;

export type PartyGraph = {
  party: PartyRow;
  reservation: ReservationRow | null;
  /** The party's open entry: waiting, notified or table assigned. */
  waitlistEntry: WaitlistRow | null;
};

/**
 * Locks a party and then its reservation and open waitlist entry, always in that order,
 * so two operations on one party can't deadlock whichever record they started from.
 */
export async function lockPartyGraph(
  transaction: DatabaseTransaction,
  locationId: string,
  partyId: string,
): Promise<PartyGraph> {
  const [party] = await transaction
    .select()
    .from(guestParties)
    .where(
      and(eq(guestParties.id, partyId), eq(guestParties.locationId, locationId)),
    )
    .for("update");

  if (!party) {
    throw new NotFoundError("guest party");
  }

  const [reservation] = await transaction
    .select()
    .from(reservations)
    .where(eq(reservations.guestPartyId, partyId))
    .for("update");
  const [waitlistEntry] = await transaction
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.guestPartyId, partyId),
        inArray(waitlistEntries.status, ["WAITING", "NOTIFIED", "TABLE_ASSIGNED"]),
      ),
    )
    .for("update");

  return {
    party,
    reservation: reservation ?? null,
    waitlistEntry: waitlistEntry ?? null,
  };
}

/** The party a reservation or waitlist entry belongs to, read without locking. */
export async function findReservationPartyId(
  transaction: DatabaseTransaction,
  locationId: string,
  reservationId: string,
): Promise<string> {
  const [row] = await transaction
    .select({ partyId: reservations.guestPartyId })
    .from(reservations)
    .where(
      and(
        eq(reservations.id, reservationId),
        eq(reservations.locationId, locationId),
      ),
    );

  if (!row) {
    throw new NotFoundError("reservation");
  }

  return row.partyId;
}

export async function findWaitlistPartyId(
  transaction: DatabaseTransaction,
  locationId: string,
  entryId: string,
): Promise<string> {
  const [row] = await transaction
    .select({ partyId: waitlistEntries.guestPartyId })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.id, entryId),
        eq(waitlistEntries.locationId, locationId),
      ),
    );

  if (!row) {
    throw new NotFoundError("waitlist entry");
  }

  return row.partyId;
}

export async function appendPartyHistory(
  transaction: DatabaseTransaction,
  input: {
    partyId: string;
    status: GuestPartyStatus;
    reason?: string | null;
    userId: string;
    occurredAt: Date;
  },
): Promise<void> {
  await transaction.insert(partyStatusHistory).values({
    guestPartyId: input.partyId,
    status: input.status,
    reason: input.reason ?? null,
    changedByUserId: input.userId,
    occurredAt: input.occurredAt,
  });
}

/**
 * Sets the party's status and appends the history entry in the caller's transaction.
 * Nothing happens when the party is already in that status.
 */
export async function changePartyStatus(
  transaction: DatabaseTransaction,
  input: {
    party: Pick<PartyRow, "id" | "status">;
    status: GuestPartyStatus;
    reason?: string | null;
    userId: string;
    occurredAt: Date;
  },
): Promise<void> {
  if (input.party.status === input.status) {
    return;
  }

  await transaction
    .update(guestParties)
    .set({ status: input.status, version: nextVersion(guestParties.version) })
    .where(eq(guestParties.id, input.party.id));
  await appendPartyHistory(transaction, {
    partyId: input.party.id,
    status: input.status,
    reason: input.reason,
    userId: input.userId,
    occurredAt: input.occurredAt,
  });
}
