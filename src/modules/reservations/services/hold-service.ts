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
import {
  reservationPlanningInterval,
  walkInHoldInterval,
} from "../rules/hold-intervals";

export type HeldTable = ActiveHold;

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
): Promise<{ overridden: HeldTable[]; reason: string | null }> {
  const holds = await findHoldsForOtherParties(transaction, {
    locationId: actor.locationId,
    tableIds: input.tableIds,
    guestPartyId: input.guestPartyId,
    now: input.now,
  });

  if (holds.length === 0) {
    return { overridden: [], reason: null };
  }

  const reason = input.overrideReason?.trim();

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

  return { overridden: holds, reason };
}

/** Appends the override record for each hold that was bypassed. */
export async function recordHoldOverrides(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: {
    sessionId: string;
    holds: readonly HeldTable[];
    reason: string;
    occurredAt: Date;
  },
): Promise<void> {
  if (input.holds.length === 0) {
    return;
  }

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      "HOLD_OVERRIDE_REASON_REQUIRED",
      "A reason is required to override a reservation hold.",
    );
  }

  await transaction.insert(reservationHoldOverrides).values(
    input.holds.map((hold) => ({
      reservationId: hold.reservationId,
      tableSessionId: input.sessionId,
      restaurantTableId: hold.tableId,
      reason: input.reason.trim(),
      overriddenByUserId: actor.userId,
      occurredAt: input.occurredAt,
    })),
  );
}

export type TableHoldIndicator = {
  tableId: string;
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

  return plans.map((plan) => {
    const hold = walkInHoldInterval(plan, context);

    return {
      tableId: plan.tableId,
      reservationId: plan.reservationId,
      reservationAt: plan.reservationAt.toISOString(),
      holdStartsAt: hold.start.toISOString(),
      holdEndsAt: hold.end.toISOString(),
      active: hold.start <= now && now < hold.end,
      guestName: canSeeNames ? plan.guestName : null,
    };
  });
}

export { reservationPlanningInterval };
