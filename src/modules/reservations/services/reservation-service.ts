import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import { guestParties, reservations } from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  combinedCapacity,
  listTableFacts,
  lockTablesForPlanning,
} from "@/modules/restaurant/queries/table-facts";
import {
  assertPermission,
  readLocationClock,
} from "@/modules/restaurant/services/access";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { localToInstant } from "@/shared/time/zoned-time";

import {
  changePartyStatus,
  appendPartyHistory,
  findReservationPartyId,
  lockPartyGraph,
  type PartyGraph,
  type ReservationRow,
} from "../repositories/party-repository";
import {
  activeAssignments,
  allAssignments,
  endAssignments,
  findActualSeating,
  findPlanningConflicts,
  insertAssignments,
  readReservationContext,
  type PlanningConflict,
  type ReservationContext,
} from "../repositories/reservation-repository";
import { reservationPlanningInterval } from "../rules/hold-intervals";
import {
  assertNoShowAllowed,
  assertReservationTransition,
  isTerminalReservation,
  partyStatusForReservation,
} from "../rules/lifecycle";
import {
  MAX_COMBINED_TABLES,
  type ReservationSource,
  type ReservationStatus,
} from "../types";
import { cancelOpenWaitlistEntry } from "./party-state";

export type CreateReservationInput = {
  guestName: string;
  partySize: number;
  phone?: string | null;
  email?: string | null;
  specialRequests?: string | null;
  /** The location's local calendar date and time, as the host typed them. */
  localDate: string;
  localTime: string;
  expectedDurationMinutes?: number | null;
  source: ReservationSource;
  notes?: string | null;
  /** A reservation is confirmed unless staff say it is still tentative. */
  status?: "PENDING" | "CONFIRMED";
  tableIds?: readonly string[];
};

export type UpdateReservationInput = {
  expectedVersion: number;
  guestName: string;
  partySize: number;
  phone?: string | null;
  email?: string | null;
  specialRequests?: string | null;
  localDate: string;
  localTime: string;
  expectedDurationMinutes: number;
  notes?: string | null;
  /** Left out, planned tables stay. An array replaces them. */
  tableIds?: readonly string[];
};

type Versioned = { id: string; version: number };

const EDITABLE: readonly ReservationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
];

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function resolveInstant(
  context: ReservationContext,
  localDate: string,
  localTime: string,
): { reservationAt: Date; businessDate: string } {
  const reservationAt = localToInstant(localDate, localTime, context.timeZone);

  if (!reservationAt) {
    throw new BusinessRuleError(
      "RESERVATION_TIME_DOES_NOT_EXIST",
      "That local time doesn't exist on that date because the clocks change.",
    );
  }

  return { reservationAt, businessDate: businessDateOf(reservationAt, context) };
}

function describeConflict(conflict: PlanningConflict): string {
  return `Table ${conflict.tableNumber} is already planned for another reservation around that time.`;
}

/**
 * Plans tables for a reservation, replacing what was planned. The tables are locked first
 * so two hosts planning one table, or a host seating it, can't interleave.
 */
async function planTables(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: {
    reservation: Pick<ReservationRow, "id" | "reservationAt" | "expectedDurationMinutes">;
    partySize: number;
    tableIds: readonly string[];
    context: ReservationContext;
    now: Date;
  },
): Promise<void> {
  const tableIds = [...new Set(input.tableIds)];

  if (tableIds.length > MAX_COMBINED_TABLES) {
    throw new BusinessRuleError(
      "TOO_MANY_TABLES",
      `A reservation can plan at most ${MAX_COMBINED_TABLES} tables.`,
    );
  }

  const tables = await lockTablesForPlanning(
    transaction,
    actor.locationId,
    tableIds,
  );

  if (tables.length > 0 && combinedCapacity(tables) < input.partySize) {
    throw new BusinessRuleError(
      "PARTY_EXCEEDS_CAPACITY",
      `This party of ${input.partySize} is over the planned capacity of ${combinedCapacity(tables)}.`,
    );
  }

  const [conflict] = await findPlanningConflicts(transaction, {
    locationId: actor.locationId,
    tableIds,
    interval: reservationPlanningInterval(input.reservation, input.context),
    excludeReservationId: input.reservation.id,
    settings: input.context,
    now: input.now,
  });

  if (conflict) {
    throw new ConflictError("PLANNING_CONFLICT", describeConflict(conflict));
  }

  const current = await activeAssignments(transaction, [input.reservation.id]);
  const currentIds = new Set(current.map((row) => row.tableId));
  const wanted = new Set(tableIds);

  await endAssignments(transaction, {
    reservationId: input.reservation.id,
    reason: tableIds.length === 0 ? "REMOVED" : "REPLACED",
    userId: actor.userId,
    at: input.now,
    tableIds: [...currentIds].filter((id) => !wanted.has(id)),
  });
  await insertAssignments(transaction, {
    reservationId: input.reservation.id,
    locationId: actor.locationId,
    tableIds: tableIds.filter((id) => !currentIds.has(id)),
    userId: actor.userId,
    at: input.now,
  });
}

export async function createReservation(
  database: Database,
  actor: Actor,
  input: CreateReservationInput,
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const context = await readReservationContext(transaction, actor.locationId);

    if (!context.allowReservations) {
      throw new BusinessRuleError(
        "RESERVATIONS_NOT_ALLOWED",
        "This location isn't taking reservations.",
      );
    }

    const { reservationAt, businessDate } = resolveInstant(
      context,
      input.localDate,
      input.localTime,
    );
    const status = input.status ?? "CONFIRMED";
    const [party] = await transaction
      .insert(guestParties)
      .values({
        locationId: actor.locationId,
        partySize: input.partySize,
        guestName: input.guestName.trim(),
        phone: blankToNull(input.phone),
        email: blankToNull(input.email),
        specialRequests: blankToNull(input.specialRequests),
        status: partyStatusForReservation(status),
      })
      .returning({ id: guestParties.id, status: guestParties.status });

    await appendPartyHistory(transaction, {
      partyId: party!.id,
      status: partyStatusForReservation(status),
      reason: "Reservation created",
      userId: actor.userId,
      occurredAt: now,
    });

    const [reservation] = await transaction
      .insert(reservations)
      .values({
        guestPartyId: party!.id,
        locationId: actor.locationId,
        reservationAt,
        businessDate,
        expectedDurationMinutes:
          input.expectedDurationMinutes ??
          context.defaultReservationDurationMinutes,
        status,
        source: input.source,
        notes: blankToNull(input.notes),
        createdByUserId: actor.userId,
      })
      .returning();

    if (input.tableIds && input.tableIds.length > 0) {
      await planTables(transaction, actor, {
        reservation: reservation!,
        partySize: input.partySize,
        tableIds: input.tableIds,
        context,
        now,
      });
    }

    return { id: reservation!.id, version: reservation!.version };
  });
}

/** Locks the reservation's party graph, then checks the reservation's version. */
export async function lockReservation(
  transaction: DatabaseTransaction,
  actor: Actor,
  reservationId: string,
  expectedVersion: number,
): Promise<PartyGraph & { reservation: ReservationRow }> {
  const partyId = await findReservationPartyId(
    transaction,
    actor.locationId,
    reservationId,
  );
  const graph = await lockPartyGraph(transaction, actor.locationId, partyId);

  if (!graph.reservation || graph.reservation.id !== reservationId) {
    throw new NotFoundError("reservation");
  }

  if (graph.reservation.version !== expectedVersion) {
    throw new ConcurrencyError("reservation", reservationId);
  }

  return { ...graph, reservation: graph.reservation };
}

async function bumpReservation(
  transaction: DatabaseTransaction,
  reservationId: string,
  changes: Partial<typeof reservations.$inferInsert>,
): Promise<Versioned> {
  const [row] = await transaction
    .update(reservations)
    .set({ ...changes, version: nextVersion(reservations.version) })
    .where(eq(reservations.id, reservationId))
    .returning({ id: reservations.id, version: reservations.version });

  return row!;
}

export async function updateReservation(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: UpdateReservationInput,
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const { party, reservation } = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );

    if (!EDITABLE.includes(reservation.status as ReservationStatus)) {
      throw new BusinessRuleError(
        "RESERVATION_NOT_EDITABLE",
        "This reservation can no longer be changed.",
      );
    }

    const context = await readReservationContext(transaction, actor.locationId);
    const { reservationAt, businessDate } = resolveInstant(
      context,
      input.localDate,
      input.localTime,
    );

    await transaction
      .update(guestParties)
      .set({
        guestName: input.guestName.trim(),
        partySize: input.partySize,
        phone: blankToNull(input.phone),
        email: blankToNull(input.email),
        specialRequests: blankToNull(input.specialRequests),
        version: nextVersion(guestParties.version),
      })
      .where(eq(guestParties.id, party.id));

    const updated = await bumpReservation(transaction, reservationId, {
      reservationAt,
      businessDate,
      expectedDurationMinutes: input.expectedDurationMinutes,
      notes: blankToNull(input.notes),
    });

    // Tables are checked again whenever anything they depend on may have changed.
    const planned =
      input.tableIds ??
      (await activeAssignments(transaction, [reservationId])).map(
        (row) => row.tableId,
      );

    if (planned.length > 0 || input.tableIds) {
      await planTables(transaction, actor, {
        reservation: {
          id: reservationId,
          reservationAt,
          expectedDurationMinutes: input.expectedDurationMinutes,
        },
        partySize: input.partySize,
        tableIds: planned,
        context,
        now,
      });
    }

    return updated;
  });
}

export async function confirmReservation(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const { reservation } = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );

    assertReservationTransition(reservation.status as ReservationStatus, "CONFIRMED");

    return bumpReservation(transaction, reservationId, { status: "CONFIRMED" });
  });
}

export async function checkInReservation(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const { party, reservation } = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );

    assertReservationTransition(reservation.status as ReservationStatus, "CHECKED_IN");

    await changePartyStatus(transaction, {
      party,
      status: "CHECKED_IN",
      reason: "Checked in",
      userId: actor.userId,
      occurredAt: now,
    });

    return bumpReservation(transaction, reservationId, {
      status: "CHECKED_IN",
      checkedInAt: now,
    });
  });
}

export async function cancelReservation(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: { expectedVersion: number; reason?: string | null },
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const graph = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );

    assertReservationTransition(
      graph.reservation.status as ReservationStatus,
      "CANCELLED",
    );

    await endAssignments(transaction, {
      reservationId,
      reason: "CANCELLED",
      userId: actor.userId,
      at: now,
    });
    await cancelOpenWaitlistEntry(transaction, actor, graph, now);
    await changePartyStatus(transaction, {
      party: graph.party,
      status: "CANCELLED",
      reason: blankToNull(input.reason) ?? "Reservation cancelled",
      userId: actor.userId,
      occurredAt: now,
    });

    return bumpReservation(transaction, reservationId, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: actor.userId,
      cancelReason: blankToNull(input.reason),
    });
  });
}

/**
 * A manual decision, never made by a job. It never touches seating: a seated reservation
 * isn't `CONFIRMED`, so the transition rules refuse it.
 */
export async function markReservationNoShow(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const graph = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );
    const context = await readReservationContext(transaction, actor.locationId);

    assertNoShowAllowed(
      {
        status: graph.reservation.status as ReservationStatus,
        reservationAt: graph.reservation.reservationAt,
      },
      now,
      context,
    );
    await endAssignments(transaction, {
      reservationId,
      reason: "NO_SHOW",
      userId: actor.userId,
      at: now,
    });
    await changePartyStatus(transaction, {
      party: graph.party,
      status: "NO_SHOW",
      reason: "Marked as a no-show",
      userId: actor.userId,
      occurredAt: now,
    });

    return bumpReservation(transaction, reservationId, {
      status: "NO_SHOW",
      noShowAt: now,
      noShowByUserId: actor.userId,
    });
  });
}

/** Replaces the planned tables alone. */
export async function setPlannedTables(
  database: Database,
  actor: Actor,
  reservationId: string,
  input: { expectedVersion: number; tableIds: readonly string[] },
): Promise<Versioned> {
  assertPermission(actor, "reservations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const { party, reservation } = await lockReservation(
      transaction,
      actor,
      reservationId,
      input.expectedVersion,
    );

    if (!EDITABLE.includes(reservation.status as ReservationStatus)) {
      throw new BusinessRuleError(
        "RESERVATION_NOT_EDITABLE",
        "This reservation can no longer be changed.",
      );
    }

    const context = await readReservationContext(transaction, actor.locationId);

    await planTables(transaction, actor, {
      reservation,
      partySize: party.partySize,
      tableIds: input.tableIds,
      context,
      now,
    });

    return bumpReservation(transaction, reservationId, {});
  });
}

export type ConflictPreview = {
  tableId: string;
  tableNumber: string;
  reservationId: string;
  guestName: string;
  partySize: number;
  reservationAt: string;
  status: ReservationStatus;
  overlapStart: string;
  overlapEnd: string;
};

/**
 * Explains planning conflicts without changing anything, for the screen to show before a
 * host commits. It shows the other reservation's name and size, never its contact data.
 */
export async function previewPlanningConflicts(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    tableIds: readonly string[];
    localDate: string;
    localTime: string;
    expectedDurationMinutes: number;
    partySize: number;
    excludeReservationId?: string | null;
  },
): Promise<{ conflicts: ConflictPreview[]; capacity: number; sufficient: boolean }> {
  assertPermission(actor, "reservations.view");

  const context = await readReservationContext(executor, actor.locationId);
  const { reservationAt } = resolveInstant(context, input.localDate, input.localTime);
  const conflicts = await findPlanningConflicts(executor, {
    locationId: actor.locationId,
    tableIds: input.tableIds,
    interval: reservationPlanningInterval(
      { reservationAt, expectedDurationMinutes: input.expectedDurationMinutes },
      context,
    ),
    excludeReservationId: input.excludeReservationId,
    settings: context,
    now: new Date(),
  });
  const facts = await listTableFacts(executor, actor.locationId);
  const capacity = combinedCapacity(
    facts.filter((table) => input.tableIds.includes(table.id)),
  );

  return {
    conflicts: conflicts.map((conflict) => ({
      tableId: conflict.tableId,
      tableNumber: conflict.tableNumber,
      reservationId: conflict.reservationId,
      guestName: conflict.guestName,
      partySize: conflict.partySize,
      reservationAt: conflict.reservationAt.toISOString(),
      status: conflict.status,
      overlapStart: conflict.overlap.start.toISOString(),
      overlapEnd: conflict.overlap.end.toISOString(),
    })),
    capacity,
    sufficient: input.tableIds.length === 0 || capacity >= input.partySize,
  };
}

export type ReservationView = {
  id: string;
  version: number;
  guestPartyId: string;
  guestName: string;
  partySize: number;
  phone: string | null;
  email: string | null;
  specialRequests: string | null;
  hasSpecialRequests: boolean;
  status: ReservationStatus;
  source: string;
  reservationAt: string;
  businessDate: string;
  expectedDurationMinutes: number;
  notes: string | null;
  checkedInAt: string | null;
  cancelledAt: string | null;
  noShowAt: string | null;
  /** Tables planned now. */
  plannedTables: { id: string; tableNumber: string }[];
  /** Every table ever planned, including those ended by seating or cancelling. */
  planningHistory: {
    tableNumber: string;
    assignedAt: string;
    removedAt: string | null;
    removalReason: string | null;
  }[];
  /** Tables the party actually used, from the Table Session linked to it. */
  actualSeating: {
    sessionId: string;
    sessionStatus: string;
    tables: { id: string; tableNumber: string }[];
  } | null;
  /** The seating this reservation can be moved to, and when its no-show window opens. */
  noShowAllowedAt: string;
};

export async function listReservations(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    fromBusinessDate: string;
    toBusinessDate: string;
    statuses?: readonly ReservationStatus[];
  },
): Promise<ReservationView[]> {
  assertPermission(actor, "reservations.view");

  const rows = await executor
    .select({ reservation: reservations, party: guestParties })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.locationId, actor.locationId),
        gte(reservations.businessDate, input.fromBusinessDate),
        lte(reservations.businessDate, input.toBusinessDate),
        input.statuses && input.statuses.length > 0
          ? inArray(reservations.status, [...input.statuses])
          : undefined,
      ),
    )
    .orderBy(asc(reservations.reservationAt), asc(reservations.id));

  return buildViews(executor, actor.locationId, rows);
}

export async function getReservation(
  executor: DatabaseExecutor,
  actor: Actor,
  reservationId: string,
): Promise<ReservationView> {
  assertPermission(actor, "reservations.view");

  const rows = await executor
    .select({ reservation: reservations, party: guestParties })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.id, reservationId),
        eq(reservations.locationId, actor.locationId),
      ),
    );
  const [view] = await buildViews(executor, actor.locationId, rows);

  if (!view) {
    throw new NotFoundError("reservation");
  }

  return view;
}

async function buildViews(
  executor: DatabaseExecutor,
  locationId: string,
  rows: {
    reservation: ReservationRow;
    party: typeof guestParties.$inferSelect;
  }[],
): Promise<ReservationView[]> {
  const ids = rows.map((row) => row.reservation.id);
  const partyIds = rows.map((row) => row.party.id);
  const context = await readReservationContext(executor, locationId);
  const planned = await activeAssignments(executor, ids);
  const history = await allAssignments(executor, ids);
  const seating = await findActualSeating(executor, partyIds);

  return rows.map(({ reservation, party }) => {
    const sessions = new Map<
      string,
      { sessionId: string; sessionStatus: string; tables: { id: string; tableNumber: string }[] }
    >();

    for (const row of seating.filter((entry) => entry.partyId === party.id)) {
      const session = sessions.get(row.sessionId) ?? {
        sessionId: row.sessionId,
        sessionStatus: row.sessionStatus,
        tables: [],
      };

      session.tables.push({ id: row.tableId, tableNumber: row.tableNumber });
      sessions.set(row.sessionId, session);
    }

    const latest = [...sessions.values()].at(-1) ?? null;

    return {
      id: reservation.id,
      version: reservation.version,
      guestPartyId: party.id,
      guestName: party.guestName,
      partySize: party.partySize,
      phone: party.phone,
      email: party.email,
      specialRequests: party.specialRequests,
      hasSpecialRequests: Boolean(party.specialRequests),
      status: reservation.status as ReservationStatus,
      source: reservation.source,
      reservationAt: reservation.reservationAt.toISOString(),
      businessDate: reservation.businessDate,
      expectedDurationMinutes: reservation.expectedDurationMinutes,
      notes: reservation.notes,
      checkedInAt: reservation.checkedInAt?.toISOString() ?? null,
      cancelledAt: reservation.cancelledAt?.toISOString() ?? null,
      noShowAt: reservation.noShowAt?.toISOString() ?? null,
      plannedTables: planned
        .filter((row) => row.reservationId === reservation.id)
        .map((row) => ({ id: row.tableId, tableNumber: row.tableNumber })),
      planningHistory: history
        .filter((row) => row.reservationId === reservation.id)
        .map((row) => ({
          tableNumber: row.tableNumber,
          assignedAt: row.assignedAt.toISOString(),
          removedAt: row.removedAt?.toISOString() ?? null,
          removalReason: row.removalReason,
        })),
      actualSeating: latest,
      noShowAllowedAt: new Date(
        reservation.reservationAt.getTime() + context.postGraceMinutes * 60_000,
      ).toISOString(),
    };
  });
}

/** What "today" means for the reservation screens. */
export async function currentBusinessDate(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<string> {
  return (await readLocationClock(executor, actor.locationId, new Date()))
    .businessDate;
}

export { isTerminalReservation };
