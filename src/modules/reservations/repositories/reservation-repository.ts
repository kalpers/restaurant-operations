import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import {
  guestParties,
  locations,
  locationSettings,
  reservationTableAssignments,
  reservations,
  restaurantTables,
  tableSessions,
  tableSessionTables,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { NotFoundError } from "@/shared/errors/app-error";

import { isHoldActive, planningWindowIsCurrent } from "../rules/hold-intervals";
import {
  reservationPlanningInterval,
  intervalsOverlap,
} from "../rules/hold-intervals";
import type { HoldSettings, Interval, ReservationStatus } from "../types";

/** The location facts reservations depend on. Every duration is a structured setting. */
export type ReservationContext = HoldSettings & {
  timeZone: string;
  businessDayCutoff: string;
  defaultReservationDurationMinutes: number;
  defaultTableTurnMinutes: number;
  defaultWaitQuoteMinutes: number;
  allowReservations: boolean;
  allowWalkIns: boolean;
};

export async function readReservationContext(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<ReservationContext> {
  const [row] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
      preHoldMinutes: locationSettings.reservationPreHoldMinutes,
      postGraceMinutes: locationSettings.reservationPostGraceMinutes,
      defaultReservationDurationMinutes:
        locationSettings.defaultReservationDurationMinutes,
      defaultTableTurnMinutes: locationSettings.defaultTableTurnMinutes,
      defaultWaitQuoteMinutes: locationSettings.defaultWaitQuoteMinutes,
      allowReservations: locationSettings.allowReservations,
      allowWalkIns: locationSettings.allowWalkIns,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

/** The statuses that still plan to use their tables. */
export const PLANNING_STATUSES: ReservationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
];

export async function activeAssignments(
  executor: DatabaseExecutor,
  reservationIds: readonly string[],
) {
  if (reservationIds.length === 0) {
    return [];
  }

  return executor
    .select({
      id: reservationTableAssignments.id,
      reservationId: reservationTableAssignments.reservationId,
      tableId: reservationTableAssignments.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
    })
    .from(reservationTableAssignments)
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, reservationTableAssignments.restaurantTableId),
    )
    .where(
      and(
        inArray(reservationTableAssignments.reservationId, [...reservationIds]),
        isNull(reservationTableAssignments.removedAt),
      ),
    )
    .orderBy(asc(restaurantTables.tableNumber));
}

/** Every assignment, ended or not: the planning history. */
export async function allAssignments(
  executor: DatabaseExecutor,
  reservationIds: readonly string[],
) {
  if (reservationIds.length === 0) {
    return [];
  }

  return executor
    .select({
      reservationId: reservationTableAssignments.reservationId,
      tableId: reservationTableAssignments.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
      assignedAt: reservationTableAssignments.assignedAt,
      removedAt: reservationTableAssignments.removedAt,
      removalReason: reservationTableAssignments.removalReason,
    })
    .from(reservationTableAssignments)
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, reservationTableAssignments.restaurantTableId),
    )
    .where(
      inArray(reservationTableAssignments.reservationId, [...reservationIds]),
    )
    .orderBy(
      asc(reservationTableAssignments.assignedAt),
      asc(restaurantTables.tableNumber),
    );
}

export async function endAssignments(
  transaction: DatabaseTransaction,
  input: {
    reservationId: string;
    reason: "REPLACED" | "CANCELLED" | "NO_SHOW" | "SEATED" | "REMOVED";
    /** Null when the guest cancelled online (Phase 22). */
    userId: string | null;
    at: Date;
    tableIds?: readonly string[];
  },
): Promise<void> {
  await transaction
    .update(reservationTableAssignments)
    .set({
      removedAt: input.at,
      removedByUserId: input.userId,
      removalReason: input.reason,
    })
    .where(
      and(
        eq(reservationTableAssignments.reservationId, input.reservationId),
        isNull(reservationTableAssignments.removedAt),
        input.tableIds
          ? inArray(
              reservationTableAssignments.restaurantTableId,
              [...input.tableIds],
            )
          : undefined,
      ),
    );
}

export async function insertAssignments(
  transaction: DatabaseTransaction,
  input: {
    reservationId: string;
    locationId: string;
    tableIds: readonly string[];
    userId: string;
    at: Date;
  },
): Promise<void> {
  if (input.tableIds.length === 0) {
    return;
  }

  await transaction.insert(reservationTableAssignments).values(
    input.tableIds.map((restaurantTableId) => ({
      reservationId: input.reservationId,
      locationId: input.locationId,
      restaurantTableId,
      assignedByUserId: input.userId,
      assignedAt: input.at,
    })),
  );
}

export type PlanningConflict = {
  reservationId: string;
  tableId: string;
  tableNumber: string;
  reservationAt: Date;
  expectedDurationMinutes: number;
  status: ReservationStatus;
  guestName: string;
  partySize: number;
  /** The part of both planning intervals that overlaps. */
  overlap: Interval;
};

/**
 * Other planning reservations on any of these tables whose planning interval overlaps
 * the candidate's. Cancelled, no-show, seated and completed reservations never block, and
 * one whose window has already ended is history. Contact data isn't read.
 */
export async function findPlanningConflicts(
  executor: DatabaseExecutor,
  input: {
    locationId: string;
    tableIds: readonly string[];
    interval: Interval;
    excludeReservationId?: string | null;
    settings: HoldSettings;
    now: Date;
  },
): Promise<PlanningConflict[]> {
  if (input.tableIds.length === 0) {
    return [];
  }

  const rows = await executor
    .select({
      reservationId: reservations.id,
      tableId: reservationTableAssignments.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
      reservationAt: reservations.reservationAt,
      expectedDurationMinutes: reservations.expectedDurationMinutes,
      status: reservations.status,
      guestName: guestParties.guestName,
      partySize: guestParties.partySize,
    })
    .from(reservationTableAssignments)
    .innerJoin(
      reservations,
      eq(reservations.id, reservationTableAssignments.reservationId),
    )
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, reservationTableAssignments.restaurantTableId),
    )
    .where(
      and(
        eq(reservations.locationId, input.locationId),
        inArray(reservationTableAssignments.restaurantTableId, [...input.tableIds]),
        isNull(reservationTableAssignments.removedAt),
        inArray(reservations.status, PLANNING_STATUSES),
        input.excludeReservationId
          ? ne(reservations.id, input.excludeReservationId)
          : undefined,
        // A coarse filter; the exact half-open comparison is made below.
        sql`${reservations.reservationAt} - make_interval(mins => ${input.settings.preHoldMinutes}::int) < ${input.interval.end.toISOString()}::timestamptz`,
        sql`${reservations.reservationAt} + make_interval(mins => ${reservations.expectedDurationMinutes} + ${input.settings.postGraceMinutes}::int) > ${input.interval.start.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(reservations.reservationAt), asc(restaurantTables.tableNumber));

  return rows.flatMap((row) => {
    const status = row.status as ReservationStatus;
    const other = reservationPlanningInterval(row, input.settings);

    if (
      !planningWindowIsCurrent(row, input.now, input.settings) ||
      !intervalsOverlap(other, input.interval)
    ) {
      return [];
    }

    return [
      {
        ...row,
        status,
        overlap: {
          start: new Date(Math.max(other.start.getTime(), input.interval.start.getTime())),
          end: new Date(Math.min(other.end.getTime(), input.interval.end.getTime())),
        },
      },
    ];
  });
}

export type ActiveHold = {
  reservationId: string;
  guestPartyId: string;
  tableId: string;
  tableNumber: string;
  reservationAt: Date;
  status: ReservationStatus;
  guestName: string;
};

/**
 * Holds in force at `now` on these tables (or every table, if none are named). This is the
 * one place a hold is decided, and a hold is never read as occupancy.
 */
export async function findActiveHolds(
  executor: DatabaseExecutor,
  input: {
    locationId: string;
    tableIds?: readonly string[];
    exceptGuestPartyId?: string | null;
    settings: HoldSettings;
    now: Date;
  },
): Promise<ActiveHold[]> {
  const earliest = new Date(input.now.getTime() - input.settings.postGraceMinutes * 60_000);
  const latest = new Date(input.now.getTime() + input.settings.preHoldMinutes * 60_000);
  const rows = await executor
    .select({
      reservationId: reservations.id,
      guestPartyId: reservations.guestPartyId,
      tableId: reservationTableAssignments.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
      reservationAt: reservations.reservationAt,
      status: reservations.status,
      guestName: guestParties.guestName,
    })
    .from(reservationTableAssignments)
    .innerJoin(
      reservations,
      eq(reservations.id, reservationTableAssignments.reservationId),
    )
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, reservationTableAssignments.restaurantTableId),
    )
    .where(
      and(
        eq(reservations.locationId, input.locationId),
        isNull(reservationTableAssignments.removedAt),
        inArray(reservations.status, PLANNING_STATUSES),
        gt(reservations.reservationAt, earliest),
        lte(reservations.reservationAt, latest),
        input.tableIds && input.tableIds.length > 0
          ? inArray(reservationTableAssignments.restaurantTableId, [...input.tableIds])
          : undefined,
        input.exceptGuestPartyId
          ? ne(reservations.guestPartyId, input.exceptGuestPartyId)
          : undefined,
      ),
    )
    .orderBy(asc(reservations.reservationAt), asc(restaurantTables.tableNumber));

  return rows
    .map((row) => ({ ...row, status: row.status as ReservationStatus }))
    .filter((row) => isHoldActive(row, input.now, input.settings));
}

/** Planned tables for reservations starting soon, held or about to be. */
export async function findUpcomingPlans(
  executor: DatabaseExecutor,
  input: { locationId: string; from: Date; to: Date },
) {
  return executor
    .select({
      reservationId: reservations.id,
      tableId: reservationTableAssignments.restaurantTableId,
      reservationAt: reservations.reservationAt,
      status: reservations.status,
      guestName: guestParties.guestName,
    })
    .from(reservationTableAssignments)
    .innerJoin(
      reservations,
      eq(reservations.id, reservationTableAssignments.reservationId),
    )
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.locationId, input.locationId),
        isNull(reservationTableAssignments.removedAt),
        inArray(reservations.status, PLANNING_STATUSES),
        gt(reservations.reservationAt, input.from),
        lte(reservations.reservationAt, input.to),
      ),
    )
    .orderBy(asc(reservations.reservationAt));
}

/** The tables a party actually used, from the Phase 5 sessions linked to it. */
export async function findActualSeating(
  executor: DatabaseExecutor,
  partyIds: readonly string[],
) {
  if (partyIds.length === 0) {
    return [];
  }

  return executor
    .select({
      partyId: tableSessions.guestPartyId,
      sessionId: tableSessions.id,
      sessionStatus: tableSessions.status,
      seatedAt: tableSessions.seatedAt,
      tableId: tableSessionTables.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
    })
    .from(tableSessions)
    .innerJoin(
      tableSessionTables,
      eq(tableSessionTables.tableSessionId, tableSessions.id),
    )
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, tableSessionTables.restaurantTableId),
    )
    .where(inArray(tableSessions.guestPartyId, [...partyIds]))
    .orderBy(asc(tableSessions.seatedAt), asc(restaurantTables.tableNumber));
}
