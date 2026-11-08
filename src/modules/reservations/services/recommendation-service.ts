import { and, asc, eq, inArray } from "drizzle-orm";

import { guestParties, waitlistEntries } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { listTableFacts } from "@/modules/restaurant/queries/table-facts";
import { actorHolds } from "@/modules/restaurant/services/access";
import { AuthorizationError } from "@/shared/errors/app-error";

import {
  findActiveHolds,
  readReservationContext,
} from "../repositories/reservation-repository";
import { walkInHoldInterval } from "../rules/hold-intervals";
import {
  recommendTables,
  type RecommendationResult,
} from "../rules/table-recommendation";
import {
  estimateWait,
  type EstimateTable,
  type WaitEstimate,
} from "../rules/wait-estimate";

function assertCanSeeParties(actor: Actor): void {
  if (
    !actorHolds(actor, "reservations.view") &&
    !actorHolds(actor, "waitlist.view")
  ) {
    throw new AuthorizationError();
  }
}

/**
 * Ranked table suggestions for a party. It reads and returns; it reserves nothing, holds
 * nothing and seats nothing, and the host chooses. No guest or HR data is read.
 */
export async function recommendTablesFor(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    partySize: number;
    preferredAreaId?: string | null;
    /** The party's own reservation hold doesn't count against it. */
    guestPartyId?: string | null;
  },
): Promise<RecommendationResult> {
  assertCanSeeParties(actor);

  const now = new Date();
  const context = await readReservationContext(executor, actor.locationId);
  const facts = await listTableFacts(executor, actor.locationId);
  const holds = await findActiveHolds(executor, {
    locationId: actor.locationId,
    exceptGuestPartyId: input.guestPartyId,
    settings: context,
    now,
  });
  const held = new Set(holds.map((hold) => hold.tableId));

  return recommendTables({
    partySize: input.partySize,
    preferredAreaId: input.preferredAreaId,
    tables: facts
      .filter((table) => table.areaType !== "TAKEOUT")
      .map((table) => ({
        id: table.id,
        tableNumber: table.tableNumber,
        capacity: table.capacity,
        areaId: table.areaId,
        areaName: table.areaName,
        availability: table.availability,
        heldForOtherParty: held.has(table.id),
      })),
  });
}

/**
 * A suggested quote, for staff to accept or replace. It is conservative, explainable and
 * based only on current seatings, the usual turn time and active holds.
 */
export async function suggestWaitQuote(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { partySize: number; excludeEntryId?: string | null },
): Promise<WaitEstimate & { turnMinutes: number }> {
  assertCanSeeParties(actor);

  const now = new Date();
  const context = await readReservationContext(executor, actor.locationId);
  const facts = await listTableFacts(executor, actor.locationId);
  const holds = await findActiveHolds(executor, {
    locationId: actor.locationId,
    settings: context,
    now,
  });
  const holdEnds = new Map<string, number>();

  for (const hold of holds) {
    const ends = walkInHoldInterval(hold, context).end.getTime() - now.getTime();
    const minutes = Math.ceil(ends / 60_000);

    holdEnds.set(hold.tableId, Math.max(holdEnds.get(hold.tableId) ?? 0, minutes));
  }

  const queue = await executor
    .select({ id: waitlistEntries.id, partySize: guestParties.partySize })
    .from(waitlistEntries)
    .innerJoin(guestParties, eq(guestParties.id, waitlistEntries.guestPartyId))
    .where(
      and(
        eq(waitlistEntries.locationId, actor.locationId),
        inArray(waitlistEntries.status, ["WAITING", "NOTIFIED", "TABLE_ASSIGNED"]),
      ),
    )
    .orderBy(asc(waitlistEntries.addedAt), asc(waitlistEntries.id));
  const ahead = [];

  for (const entry of queue) {
    if (entry.id === input.excludeEntryId) {
      break;
    }

    ahead.push(entry.partySize);
  }

  const tables: EstimateTable[] = facts
    .filter((table) => table.areaType !== "TAKEOUT")
    .map((table) => ({
      id: table.id,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
      areaId: table.areaId,
      areaName: table.areaName,
      availability: table.availability,
      heldForOtherParty: false,
      occupiedForMinutes: table.occupiedSince
        ? Math.max(
            0,
            Math.floor((now.getTime() - table.occupiedSince.getTime()) / 60_000),
          )
        : null,
      holdEndsInMinutes: holdEnds.get(table.id) ?? null,
    }));

  return {
    ...estimateWait({
      partySize: input.partySize,
      partiesAhead: ahead,
      tables,
      turnMinutes: context.defaultTableTurnMinutes,
    }),
    turnMinutes: context.defaultTableTurnMinutes,
  };
}

export type HostTable = {
  id: string;
  tableNumber: string;
  capacity: number;
  areaId: string;
  areaName: string;
  availability: "AVAILABLE" | "DIRTY" | "OUT_OF_SERVICE" | "OCCUPIED" | "INACTIVE";
  /** Held for a reservation right now. Still physically available. */
  held: boolean;
};

/**
 * The tables the host screens can plan with or seat at: in use, not Takeout, with their
 * physical availability and, separately, whether a reservation holds them right now.
 */
export async function listHostTables(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<HostTable[]> {
  assertCanSeeParties(actor);

  const context = await readReservationContext(executor, actor.locationId);
  const holds = await findActiveHolds(executor, {
    locationId: actor.locationId,
    settings: context,
    now: new Date(),
  });
  const held = new Set(holds.map((hold) => hold.tableId));

  return (await listTableFacts(executor, actor.locationId))
    .filter((table) => table.usable && table.areaType !== "TAKEOUT")
    .map((table) => ({
      id: table.id,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
      areaId: table.areaId,
      areaName: table.areaName,
      availability: table.availability,
      held: held.has(table.id),
    }));
}
