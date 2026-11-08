import type { Database } from "@/db";
import { guestParties } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  appendPartyHistory,
} from "@/modules/reservations/repositories/party-repository";
import { readReservationContext } from "@/modules/reservations/repositories/reservation-repository";
import {
  assertPartySeatable,
  markPartySeated,
} from "@/modules/reservations/services/party-state";
import { lockReservation } from "@/modules/reservations/services/reservation-service";
import { lockWaitlistEntry } from "@/modules/reservations/services/waitlist-service";
import { assertPermission } from "@/modules/restaurant/services/access";
import { BusinessRuleError } from "@/shared/errors/app-error";

import {
  mapSeatingViolation,
  seatPartyInTransaction,
  type SeatPartyInput,
  type SeatPartyResult,
} from "../seat-party/seat-party";

/** The choices a host makes at the stand. The party's size comes from the Guest Party. */
export type SeatGuestOptions = Omit<SeatPartyInput, "partySize" | "guestPartyId">;

export type SeatGuestPartyResult = SeatPartyResult & {
  /** The version of the reservation or waitlist entry after seating, if there was one. */
  guestPartyId: string;
};

/**
 * Seats a reservation's party. The reservation and its party are locked first and checked
 * against the version the host saw, then the Phase 5 seating runs on the same transaction,
 * and the party, reservation and any waitlist entry move to SEATED with it. The planned
 * tables are ended and kept, so they can differ from the tables actually used. A failure
 * anywhere leaves every record as it was.
 */
export async function seatReservationParty(
  database: Database,
  actor: Actor,
  input: SeatGuestOptions & { reservationId: string; expectedVersion: number },
): Promise<SeatGuestPartyResult> {
  assertPermission(actor, "restaurant.seat");
  assertPermission(actor, "reservations.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const { reservationId, expectedVersion, ...options } = input;
      const graph = await lockReservation(
        transaction,
        actor,
        reservationId,
        expectedVersion,
      );

      assertPartySeatable(graph);

      const seated = await seatPartyInTransaction(transaction, actor, {
        ...options,
        partySize: graph.party.partySize,
        guestPartyId: graph.party.id,
      });

      await markPartySeated(transaction, actor, graph, now);

      return { ...seated, guestPartyId: graph.party.id };
    });
  } catch (error) {
    throw mapSeatingViolation(error);
  }
}

/**
 * Seats a waiting party, with the same guarantees. The entry is locked, so one entry can
 * never create two sessions: a second attempt waits and then finds it already seated.
 */
export async function seatWaitlistParty(
  database: Database,
  actor: Actor,
  input: SeatGuestOptions & { entryId: string; expectedVersion: number },
): Promise<SeatGuestPartyResult> {
  assertPermission(actor, "restaurant.seat");
  assertPermission(actor, "waitlist.seat");

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const { entryId, expectedVersion, ...options } = input;
      const graph = await lockWaitlistEntry(
        transaction,
        actor,
        entryId,
        expectedVersion,
      );

      assertPartySeatable(graph);

      const seated = await seatPartyInTransaction(transaction, actor, {
        ...options,
        partySize: graph.party.partySize,
        guestPartyId: graph.party.id,
      });

      await markPartySeated(transaction, actor, graph, now);

      return { ...seated, guestPartyId: graph.party.id };
    });
  } catch (error) {
    throw mapSeatingViolation(error);
  }
}

export type SeatWalkInInput = SeatGuestOptions & {
  guestName: string;
  partySize: number;
  phone?: string | null;
  email?: string | null;
  specialRequests?: string | null;
};

/** A walk-in seated at once: a Guest Party is created and seated, with no waitlist entry. */
export async function seatWalkIn(
  database: Database,
  actor: Actor,
  input: SeatWalkInInput,
): Promise<SeatGuestPartyResult> {
  assertPermission(actor, "restaurant.seat");
  assertPermission(actor, "waitlist.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const context = await readReservationContext(transaction, actor.locationId);

      if (!context.allowWalkIns) {
        throw new BusinessRuleError(
          "WALK_INS_NOT_ALLOWED",
          "This location isn't taking walk-ins.",
        );
      }

      const {
        guestName,
        partySize,
        phone,
        email,
        specialRequests,
        ...options
      } = input;
      const [party] = await transaction
        .insert(guestParties)
        .values({
          locationId: actor.locationId,
          partySize,
          guestName: guestName.trim(),
          phone: phone?.trim() || null,
          email: email?.trim() || null,
          specialRequests: specialRequests?.trim() || null,
          status: "SEATED",
        })
        .returning({ id: guestParties.id });

      await appendPartyHistory(transaction, {
        partyId: party!.id,
        status: "SEATED",
        reason: "Walk-in seated",
        userId: actor.userId,
        occurredAt: now,
      });

      const seated = await seatPartyInTransaction(transaction, actor, {
        ...options,
        partySize,
        guestPartyId: party!.id,
      });

      return { ...seated, guestPartyId: party!.id };
    });
  } catch (error) {
    throw mapSeatingViolation(error);
  }
}
