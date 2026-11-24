import { reservationHoldOverrides } from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { actorHolds } from "@/modules/restaurant/services/access";
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
} from "@/shared/errors/app-error";

import {
  findActiveHolds,
  findUpcomingPlans,
  readReservationContext,
  type ActiveHold,
} from "../repositories/reservation-repository";
import { findEventBlocks } from "../queries/event-blocks";
import {
  reservationPlanningInterval,
  walkInHoldInterval,
} from "../rules/hold-intervals";
import { describeEventBlock } from "./event-holds";

export type HeldTable = ActiveHold;

/** Phase 36 (policy 7): a table an event holds right now, for seating. */
export type EventHeldTable = { eventBookingId: string; eventNumber: string; name: string; tableId: string; endsAt: Date };

/**
 * Holds on these tables for anyone but `guestPartyId`'s own reservation. Call this after
 * the tables are locked. A hold is a planning protection, never occupancy.
 */
export async function findHoldsForOtherParties(
  executor: DatabaseExecutor,
  input: {
    locationId: string;
    tableIds: readonly string[];
    guestPartyId?: string | null;
    now: Date;
  },
): Promise<HeldTable[]> {
  const context = await readReservationContext(executor, input.locationId);

  return findActiveHolds(executor, {
    locationId: input.locationId,
    tableIds: input.tableIds,
    exceptGuestPartyId: input.guestPartyId,
    settings: context,
    now: input.now,
  });
}

function describeHold(hold: HeldTable, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(hold.reservationAt);

  return `Table ${hold.tableNumber} is held for a ${time} reservation.`;
}

/**
 * The reservation-hold rule for seating. An ordinary host can't seat an unrelated party
 * at a held table. A manager with `reservations.override-hold` can, with a reason, and the
 * holds that were overridden are returned so they can be recorded. It stands beside the
 * Phase 5 rules and bypasses none of them: those run first.
 */
export async function checkHoldsForSeating(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: {
    tableIds: readonly string[];
    guestPartyId?: string | null;
    overrideReason?: string | null;
    now: Date;
  },
): Promise<{ overridden: HeldTable[]; eventsOverridden: EventHeldTable[]; reason: string | null }> {
  const holds = await findHoldsForOtherParties(transaction, {
    locationId: actor.locationId,
    tableIds: input.tableIds,
    guestPartyId: input.guestPartyId,
    now: input.now,
  });
  // Phase 36 (policy 7): an event's tables are held for its party over the whole block.
  const blocks = await findEventBlocks(transaction, {
    locationId: actor.locationId,
    interval: { start: input.now, end: new Date(input.now.getTime() + 1) },
    tableIds: input.tableIds,
    buyouts: "exclude",
    exceptGuestPartyId: input.guestPartyId,
  });
  const wanted = new Set(input.tableIds);
  const eventHolds: EventHeldTable[] = blocks.flatMap((block) =>
    block.tableIds
      .filter((tableId) => wanted.has(tableId))
      .map((tableId) => ({ eventBookingId: block.eventId, eventNumber: block.eventNumber, name: block.name, tableId, endsAt: block.interval.end })),
  );

  if (holds.length === 0 && eventHolds.length === 0) {
    return { overridden: [], eventsOverridden: [], reason: null };
  }

  const reason = input.overrideReason?.trim();

  if (!reason && eventHolds.length > 0) {
    const context = await readReservationContext(transaction, actor.locationId);

    throw new ConflictError(
      "EVENT_HOLD_ACTIVE",
      `${describeEventBlock(blocks[0]!, context.timeZone)}${
        actorHolds(actor, "reservations.override-hold") ? " Give a reason to override the hold." : " A manager can override this."
      }`,
    );
  }

  if (!reason) {
    const context = await readReservationContext(transaction, actor.locationId);

    throw new ConflictError(
      "RESERVATION_HOLD_ACTIVE",
      `${describeHold(holds[0]!, context.timeZone)}${
        actorHolds(actor, "reservations.override-hold")
          ? " Give a reason to override the hold."
          : " A manager can override this."
      }`,
    );
  }

  if (!actorHolds(actor, "reservations.override-hold")) {
    throw new AuthorizationError();
  }

  return { overridden: holds, eventsOverridden: eventHolds, reason };
}

/** Appends the override record for each hold that was bypassed. */
export async function recordHoldOverrides(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: {
    sessionId: string;
    holds: readonly HeldTable[];
    /** Phase 36 (policy 7): event holds bypassed, recorded the same way. */
    eventHolds?: readonly EventHeldTable[];
    reason: string;
    occurredAt: Date;
  },
): Promise<void> {
  const eventHolds = input.eventHolds ?? [];

  if (input.holds.length === 0 && eventHolds.length === 0) {
    return;
  }

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      "HOLD_OVERRIDE_REASON_REQUIRED",
      "A reason is required to override a reservation hold.",
    );
  }

  await transaction.insert(reservationHoldOverrides).values([
    ...input.holds.map((hold) => ({
      reservationId: hold.reservationId,
      tableSessionId: input.sessionId,
      restaurantTableId: hold.tableId,
      reason: input.reason.trim(),
      overriddenByUserId: actor.userId,
      occurredAt: input.occurredAt,
    })),
    ...eventHolds.map((hold) => ({
      eventBookingId: hold.eventBookingId,
      category: "EVENT_HOLD_OVERRIDE",
      tableSessionId: input.sessionId,
      restaurantTableId: hold.tableId,
      reason: input.reason.trim(),
      overriddenByUserId: actor.userId,
      occurredAt: input.occurredAt,
    })),
  ]);
}

export type TableHoldIndicator = {
  /** Phase 36 (policy 7): a reservation's hold, or an event's block. */
  kind: "RESERVATION" | "EVENT";
  tableId: string;
  /** The reservation, or (for an event) the event booking. */
  reservationId: string;
  reservationAt: string;
  holdStartsAt: string;
  holdEndsAt: string;
  /** True while the hold is in force. Otherwise the reservation is coming up. */
  active: boolean;
  /** Only for viewers who may see reservations. */
  guestName: string | null;
};

/**
 * Near-term reservation plans per table for the floor. It is separate from occupancy: a
 * table with an indicator may still be physically available.
 */
export async function listTableHoldIndicators(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { withinMinutes?: number } = {},
): Promise<TableHoldIndicator[]> {
  if (!actorHolds(actor, "restaurant.view") && !actorHolds(actor, "reservations.view")) {
    throw new AuthorizationError();
  }

  const now = new Date();
  const context = await readReservationContext(executor, actor.locationId);
  const within = input.withinMinutes ?? 120;
  const plans = await findUpcomingPlans(executor, {
    locationId: actor.locationId,
    from: new Date(now.getTime() - context.postGraceMinutes * 60_000),
    to: new Date(now.getTime() + within * 60_000),
  });
  const canSeeNames = actorHolds(actor, "reservations.view");
  const blocks = await findEventBlocks(executor, {
    locationId: actor.locationId,
    interval: { start: now, end: new Date(now.getTime() + within * 60_000) },
    buyouts: "exclude",
  });
  const eventIndicators: TableHoldIndicator[] = blocks.flatMap((block) =>
    block.tableIds.map((tableId) => ({
      kind: "EVENT" as const,
      tableId,
      reservationId: block.eventId,
      reservationAt: block.interval.start.toISOString(),
      holdStartsAt: block.interval.start.toISOString(),
      holdEndsAt: block.interval.end.toISOString(),
      active: block.interval.start <= now && now < block.interval.end,
      guestName: canSeeNames ? `${block.eventNumber} ${block.name}` : null,
    })),
  );

  return [...eventIndicators, ...plans.map((plan) => {
    const hold = walkInHoldInterval(plan, context);

    return {
      kind: "RESERVATION" as const,
      tableId: plan.tableId,
      reservationId: plan.reservationId,
      reservationAt: plan.reservationAt.toISOString(),
      holdStartsAt: hold.start.toISOString(),
      holdEndsAt: hold.end.toISOString(),
      active: hold.start <= now && now < hold.end,
      guestName: canSeeNames ? plan.guestName : null,
    };
  })];
}

export { reservationPlanningInterval };
