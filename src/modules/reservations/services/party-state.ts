import { eq } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import { reservations, waitlistEntries } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError } from "@/shared/errors/app-error";

import {
  changePartyStatus,
  lockPartyGraph,
  type PartyGraph,
} from "../repositories/party-repository";
import { endAssignments } from "../repositories/reservation-repository";
import { endWaitlistAssignments } from "../repositories/waitlist-repository";
import { partyStatusForReservation } from "../rules/lifecycle";
import type { ReservationStatus } from "../types";

// The Guest Party, its Reservation and its Waitlist entry change together. These functions
// are what the seating workflows call inside their one transaction, and each expects the
// party graph to be locked already (`lockPartyGraph`).

const SEATABLE_PARTY: readonly string[] = ["EXPECTED", "WAITING", "CHECKED_IN"];

/** Ends the party's open waitlist entry as cancelled, when it has one. */
export async function cancelOpenWaitlistEntry(
  transaction: DatabaseTransaction,
  actor: Actor,
  graph: PartyGraph,
  at: Date,
): Promise<void> {
  if (!graph.waitlistEntry) {
    return;
  }

  await endWaitlistAssignments(transaction, {
    entryId: graph.waitlistEntry.id,
    reason: "CANCELLED",
    at,
  });
  await transaction
    .update(waitlistEntries)
    .set({
      status: "CANCELLED",
      removedAt: at,
      removedByUserId: actor.userId,
      version: nextVersion(waitlistEntries.version),
    })
    .where(eq(waitlistEntries.id, graph.waitlistEntry.id));
}

/** Refuses before any table is touched, so a party that can't be seated costs nothing. */
export function assertPartySeatable(graph: PartyGraph): void {
  if (!SEATABLE_PARTY.includes(graph.party.status)) {
    throw new BusinessRuleError(
      "PARTY_NOT_SEATABLE",
      "This party has already been seated or is no longer expected.",
    );
  }

  if (graph.reservation) {
    const status = graph.reservation.status as ReservationStatus;

    if (status === "PENDING") {
      throw new BusinessRuleError(
        "RESERVATION_NOT_CONFIRMED",
        "Confirm this reservation before seating the party.",
      );
    }

    if (status !== "CONFIRMED" && status !== "CHECKED_IN") {
      throw new BusinessRuleError(
        "PARTY_NOT_SEATABLE",
        "This reservation is no longer active.",
      );
    }
  }
}

/**
 * Seating happened: the party, its reservation and its waitlist entry all become SEATED,
 * and the planned tables are ended rather than deleted, so planned and actual stay
 * separate. A reservation must be confirmed before its party can be seated.
 */
export async function markPartySeated(
  transaction: DatabaseTransaction,
  actor: Actor,
  graph: PartyGraph,
  at: Date,
): Promise<void> {
  assertPartySeatable(graph);

  if (graph.reservation) {
    await endAssignments(transaction, {
      reservationId: graph.reservation.id,
      reason: "SEATED",
      userId: actor.userId,
      at,
    });
    await transaction
      .update(reservations)
      .set({
        status: "SEATED",
        checkedInAt: graph.reservation.checkedInAt ?? at,
        version: nextVersion(reservations.version),
      })
      .where(eq(reservations.id, graph.reservation.id));
  }

  if (graph.waitlistEntry) {
    await endWaitlistAssignments(transaction, {
      entryId: graph.waitlistEntry.id,
      reason: "SEATED",
      at,
    });
    await transaction
      .update(waitlistEntries)
      .set({
        status: "SEATED",
        seatedAt: at,
        version: nextVersion(waitlistEntries.version),
      })
      .where(eq(waitlistEntries.id, graph.waitlistEntry.id));
  }

  await changePartyStatus(transaction, {
    party: graph.party,
    status: "SEATED",
    reason: "Seated",
    userId: actor.userId,
    occurredAt: at,
  });
}

/** The visit is over: a seated party and its seated reservation become COMPLETED. */
export async function markPartyCompleted(
  transaction: DatabaseTransaction,
  actor: Actor,
  locationId: string,
  partyId: string,
  at: Date,
): Promise<void> {
  const graph = await lockPartyGraph(transaction, locationId, partyId);

  if (graph.reservation?.status === "SEATED") {
    await transaction
      .update(reservations)
      .set({ status: "COMPLETED", version: nextVersion(reservations.version) })
      .where(eq(reservations.id, graph.reservation.id));
  }

  if (graph.party.status === "SEATED") {
    await changePartyStatus(transaction, {
      party: graph.party,
      status: "COMPLETED",
      reason: "Visit completed",
      userId: actor.userId,
      occurredAt: at,
    });
  }
}

/**
 * The seating was cancelled as a mistake. The party goes back to waiting or checked in,
 * exactly where it was, and its reservation or waitlist entry is restored with it.
 */
export async function revertPartySeating(
  transaction: DatabaseTransaction,
  actor: Actor,
  locationId: string,
  partyId: string,
  at: Date,
): Promise<void> {
  const graph = await lockPartyGraph(transaction, locationId, partyId);

  if (graph.party.status !== "SEATED") {
    return;
  }

  const entries = await transaction
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.guestPartyId, partyId));
  const entry = entries.find((row) => row.status === "SEATED");

  if (entry) {
    await transaction
      .update(waitlistEntries)
      .set({
        status: entry.notifiedAt ? "NOTIFIED" : "WAITING",
        seatedAt: null,
        version: nextVersion(waitlistEntries.version),
      })
      .where(eq(waitlistEntries.id, entry.id));
  }

  if (graph.reservation?.status === "SEATED") {
    await transaction
      .update(reservations)
      .set({ status: "CHECKED_IN", version: nextVersion(reservations.version) })
      .where(eq(reservations.id, graph.reservation.id));
  }

  const restored = entry ? "WAITING" : partyStatusForReservation("CHECKED_IN");

  await changePartyStatus(transaction, {
    party: graph.party,
    status: restored,
    reason: "Seating cancelled",
    userId: actor.userId,
    occurredAt: at,
  });
}
