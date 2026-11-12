import { and, asc, eq, inArray, ne } from "drizzle-orm";

import {
  guestParties,
  guestProfiles,
  locations,
  orderItems,
  orders,
  reservations,
  tableSessions,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { divideRoundHalfUp, sumDecimals } from "@/shared/decimal/decimal";
import { NotFoundError } from "@/shared/errors/app-error";

import { assertPermission } from "../services/guest-access";

// Phase 21 (policy 5, D15): a profile's visits, worked out on read from the parties linked to
// it, their seating and their checks. Money and item names come from order snapshots only
// (rule 4), so a later price or name change never alters history. Nothing is stored.

export type GuestVisit = {
  guestPartyId: string;
  locationName: string;
  timeZone: string;
  /** The reservation time, the seating time, or when the party was added. */
  at: string;
  partySize: number;
  status: string;
  checks: { orderId: string; orderNumber: number; status: string; totalDue: string; items: string[] }[];
};

export type GuestVisitSummary = {
  visits: number;
  seatedVisits: number;
  noShows: number;
  cancellations: number;
  lastVisitAt: string | null;
  /** Average total due of CLOSED checks per seated visit with one, or null. */
  averageSpend: string | null;
};

export async function getGuestVisits(
  executor: DatabaseExecutor,
  actor: Actor,
  profileId: string,
): Promise<{ summary: GuestVisitSummary; visits: GuestVisit[] }> {
  assertPermission(actor, "guests.view");

  const [profile] = await executor
    .select({ id: guestProfiles.id })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, profileId), eq(guestProfiles.organizationId, actor.organizationId)));

  if (!profile) {
    throw new NotFoundError("guest profile");
  }

  const parties = await executor
    .select({
      party: guestParties,
      locationName: locations.name,
      timeZone: locations.timezone,
      reservationAt: reservations.reservationAt,
    })
    .from(guestParties)
    .innerJoin(locations, eq(locations.id, guestParties.locationId))
    .leftJoin(reservations, eq(reservations.guestPartyId, guestParties.id))
    .where(and(eq(guestParties.guestProfileId, profile.id), eq(locations.organizationId, actor.organizationId)));
  const partyIds = parties.map((row) => row.party.id);
  const sessions = partyIds.length
    ? await executor
        .select({ id: tableSessions.id, partyId: tableSessions.guestPartyId, seatedAt: tableSessions.seatedAt })
        .from(tableSessions)
        .where(inArray(tableSessions.guestPartyId, partyIds))
    : [];
  const checks = sessions.length
    ? await executor
        .select({
          id: orders.id,
          sessionId: orders.tableSessionId,
          orderNumber: orders.orderNumber,
          status: orders.status,
          totalDue: orders.totalDue,
        })
        .from(orders)
        .where(and(inArray(orders.tableSessionId, sessions.map((session) => session.id)), ne(orders.status, "VOIDED")))
        .orderBy(asc(orders.orderNumber))
    : [];
  const items = checks.length
    ? await executor
        .select({ orderId: orderItems.orderId, name: orderItems.menuItemNameSnapshot, quantity: orderItems.quantity })
        .from(orderItems)
        .where(and(inArray(orderItems.orderId, checks.map((check) => check.id)), inArray(orderItems.status, ["SUBMITTED", "SPLIT"])))
        .orderBy(asc(orderItems.submittedAt), asc(orderItems.id))
    : [];

  const visits: GuestVisit[] = parties.map(({ party, locationName, timeZone, reservationAt }) => {
    const partySessions = sessions.filter((session) => session.partyId === party.id);
    const sessionIds = new Set(partySessions.map((session) => session.id));
    const seatedAt = partySessions.map((session) => session.seatedAt).sort((a, b) => a.getTime() - b.getTime())[0];

    return {
      guestPartyId: party.id,
      locationName,
      timeZone,
      at: (reservationAt ?? seatedAt ?? party.createdAt).toISOString(),
      partySize: party.partySize,
      status: party.status,
      checks: checks
        .filter((check) => check.sessionId && sessionIds.has(check.sessionId))
        .map((check) => ({
          orderId: check.id,
          orderNumber: check.orderNumber,
          status: check.status,
          totalDue: check.totalDue,
          items: items
            .filter((item) => item.orderId === check.id)
            .map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name)),
        })),
    };
  });

  visits.sort((left, right) => right.at.localeCompare(left.at));

  const seated = visits.filter((visit) => visit.status === "SEATED" || visit.status === "COMPLETED");
  const spends = seated.flatMap((visit) => {
    const closed = visit.checks.filter((check) => check.status === "CLOSED");

    return closed.length > 0 ? [sumDecimals(closed.map((check) => check.totalDue), 2)] : [];
  });

  return {
    summary: {
      visits: visits.length,
      seatedVisits: seated.length,
      noShows: visits.filter((visit) => visit.status === "NO_SHOW").length,
      cancellations: visits.filter((visit) => visit.status === "CANCELLED").length,
      lastVisitAt: seated[0]?.at ?? null,
      averageSpend: spends.length > 0 ? divideRoundHalfUp(sumDecimals(spends, 2), String(spends.length), 2) : null,
    },
    visits,
  };
}
