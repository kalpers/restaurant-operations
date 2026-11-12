import { and, asc, eq, inArray } from "drizzle-orm";
import { attachProfileToParty } from "./guest-profile-service";
import { loadPartyGuestFacts } from "./party-allergy-service";
import type { PartyGuestView } from "./reservation-service";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import { guestParties, reservations, waitlistEntries } from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  combinedCapacity,
  lockTablesForPlanning,
} from "@/modules/restaurant/queries/table-facts";
import { assertPermission } from "@/modules/restaurant/services/access";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  appendPartyHistory,
  changePartyStatus,
  findWaitlistPartyId,
  lockPartyGraph,
  type PartyGraph,
  type WaitlistRow,
} from "../repositories/party-repository";
import { readReservationContext } from "../repositories/reservation-repository";
import {
  activeWaitlistAssignments,
  endWaitlistAssignments,
  insertWaitlistAssignments,
} from "../repositories/waitlist-repository";
import { assertWaitlistTransition } from "../rules/lifecycle";
import { MAX_COMBINED_TABLES, type WaitlistStatus } from "../types";

type Versioned = { id: string; version: number };

export type AddToWaitlistInput = {
  /** A new walk-in party. Left out when `guestPartyId` names an existing one. */
  guestName?: string;
  partySize?: number;
  phone?: string | null;
  email?: string | null;
  specialRequests?: string | null;
  /** A reservation party that is waiting for a table: no second party is created. */
  guestPartyId?: string;
  quotedWaitMinutes?: number | null;
  preferredAreaId?: string | null;
  notes?: string | null;
  /** Phase 21 (policy 2): the walk-in's guest profile, linked by hand. Needs `guests.manage`. */
  guestProfileId?: string | null;
};

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

/** Locks the entry's party graph, then checks the entry's version. */
export async function lockWaitlistEntry(
  transaction: DatabaseTransaction,
  actor: Actor,
  entryId: string,
  expectedVersion: number,
): Promise<PartyGraph & { waitlistEntry: WaitlistRow }> {
  const partyId = await findWaitlistPartyId(
    transaction,
    actor.locationId,
    entryId,
  );
  const graph = await lockPartyGraph(transaction, actor.locationId, partyId);
  const entry = graph.waitlistEntry;

  // An entry that has ended is no longer in the open graph.
  if (!entry || entry.id !== entryId) {
    const [ended] = await transaction
      .select({ status: waitlistEntries.status })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, entryId));

    if (!ended) {
      throw new NotFoundError("waitlist entry");
    }

    throw new BusinessRuleError(
      "WAITLIST_ENTRY_CLOSED",
      "This waitlist entry has already ended.",
    );
  }

  if (entry.version !== expectedVersion) {
    throw new ConcurrencyError("waitlist entry", entryId);
  }

  return { ...graph, waitlistEntry: entry };
}

async function bumpEntry(
  transaction: DatabaseTransaction,
  entryId: string,
  changes: Partial<typeof waitlistEntries.$inferInsert>,
): Promise<Versioned> {
  const [row] = await transaction
    .update(waitlistEntries)
    .set({ ...changes, version: nextVersion(waitlistEntries.version) })
    .where(eq(waitlistEntries.id, entryId))
    .returning({ id: waitlistEntries.id, version: waitlistEntries.version });

  return row!;
}

/**
 * Adds a walk-in to the waitlist, creating its Guest Party, or puts an existing
 * reservation party on it without creating a second one.
 */
export async function addToWaitlist(
  database: Database,
  actor: Actor,
  input: AddToWaitlistInput,
): Promise<Versioned> {
  assertPermission(actor, "waitlist.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const context = await readReservationContext(transaction, actor.locationId);
      let partyId = input.guestPartyId;

      if (partyId) {
        const graph = await lockPartyGraph(transaction, actor.locationId, partyId);

        if (graph.party.status === "SEATED" || graph.waitlistEntry) {
          throw new BusinessRuleError(
            "PARTY_NOT_WAITLISTABLE",
            "This party is already seated or already on the waitlist.",
          );
        }

        if (
          !graph.reservation ||
          (graph.reservation.status !== "CONFIRMED" &&
            graph.reservation.status !== "CHECKED_IN")
        ) {
          throw new BusinessRuleError(
            "PARTY_NOT_WAITLISTABLE",
            "Only a confirmed or checked-in reservation party can join the waitlist.",
          );
        }

        await changePartyStatus(transaction, {
          party: graph.party,
          status: "WAITING",
          reason: "Waiting for a table",
          userId: actor.userId,
          occurredAt: now,
        });
      } else {
        if (!context.allowWalkIns) {
          throw new BusinessRuleError(
            "WALK_INS_NOT_ALLOWED",
            "This location isn't taking walk-ins.",
          );
        }

        if (!input.guestName?.trim() || !input.partySize) {
          throw new BusinessRuleError(
            "PARTY_DETAILS_REQUIRED",
            "A name and party size are required.",
          );
        }

        const [party] = await transaction
          .insert(guestParties)
          .values({
            locationId: actor.locationId,
            partySize: input.partySize,
            guestName: input.guestName.trim(),
            phone: blankToNull(input.phone),
            email: blankToNull(input.email),
            specialRequests: blankToNull(input.specialRequests),
            status: "WAITING",
          })
          .returning({ id: guestParties.id });

        partyId = party!.id;
        await appendPartyHistory(transaction, {
          partyId,
          status: "WAITING",
          reason: "Added to the waitlist",
          userId: actor.userId,
          occurredAt: now,
        });

        if (input.guestProfileId) {
          await attachProfileToParty(transaction, actor, { guestPartyId: partyId, guestProfileId: input.guestProfileId });
        }
      }

      const [entry] = await transaction
        .insert(waitlistEntries)
        .values({
          guestPartyId: partyId,
          locationId: actor.locationId,
          status: "WAITING",
          quotedWaitMinutes: input.quotedWaitMinutes ?? null,
          preferredAreaId: input.preferredAreaId ?? null,
          addedAt: now,
          createdByUserId: actor.userId,
          notes: blankToNull(input.notes),
        })
        .returning({ id: waitlistEntries.id, version: waitlistEntries.version });

      return entry!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "WAITLIST_ENTRY_EXISTS",
        "This party is already on the waitlist.",
      );
    }

    throw error;
  }
}

/** The quote, notes and area preference. A quote is an estimate for the guest, not a promise. */
export async function updateWaitlistEntry(
  database: Database,
  actor: Actor,
  entryId: string,
  input: {
    expectedVersion: number;
    quotedWaitMinutes: number | null;
    preferredAreaId?: string | null;
    notes?: string | null;
  },
): Promise<Versioned> {
  assertPermission(actor, "waitlist.manage");

  return withTransaction(database, async (transaction) => {
    await lockWaitlistEntry(transaction, actor, entryId, input.expectedVersion);

    return bumpEntry(transaction, entryId, {
      quotedWaitMinutes: input.quotedWaitMinutes,
      ...(input.preferredAreaId !== undefined
        ? { preferredAreaId: input.preferredAreaId }
        : {}),
      ...(input.notes !== undefined ? { notes: blankToNull(input.notes) } : {}),
    });
  });
}

/**
 * Records that staff contacted the party. Nothing is sent: there is no SMS, email or push
 * in this application.
 */
export async function notifyWaitlistEntry(
  database: Database,
  actor: Actor,
  entryId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "waitlist.notify");

  return withTransaction(database, async (transaction) => {
    const { waitlistEntry } = await lockWaitlistEntry(
      transaction,
      actor,
      entryId,
      input.expectedVersion,
    );

    assertWaitlistTransition(waitlistEntry.status as WaitlistStatus, "NOTIFIED");

    return bumpEntry(transaction, entryId, {
      status: "NOTIFIED",
      notifiedAt: new Date(),
      notifiedByUserId: actor.userId,
    });
  });
}

/**
 * Records the host's chosen tables. It plans only: nothing becomes occupied, and the
 * selection can be replaced or cleared. An empty list clears it.
 */
export async function assignWaitlistTables(
  database: Database,
  actor: Actor,
  entryId: string,
  input: { expectedVersion: number; tableIds: readonly string[] },
): Promise<Versioned> {
  assertPermission(actor, "waitlist.manage");

  const tableIds = [...new Set(input.tableIds)];

  if (tableIds.length > MAX_COMBINED_TABLES) {
    throw new BusinessRuleError(
      "TOO_MANY_TABLES",
      `At most ${MAX_COMBINED_TABLES} tables can be chosen.`,
    );
  }

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const { party, waitlistEntry } = await lockWaitlistEntry(
      transaction,
      actor,
      entryId,
      input.expectedVersion,
    );
    const tables = await lockTablesForPlanning(
      transaction,
      actor.locationId,
      tableIds,
    );

    if (tables.length > 0 && combinedCapacity(tables) < party.partySize) {
      throw new BusinessRuleError(
        "PARTY_EXCEEDS_CAPACITY",
        `This party of ${party.partySize} is over the chosen capacity of ${combinedCapacity(tables)}.`,
      );
    }

    const status = waitlistEntry.status as WaitlistStatus;
    const next: WaitlistStatus =
      tableIds.length > 0
        ? "TABLE_ASSIGNED"
        : waitlistEntry.notifiedAt
          ? "NOTIFIED"
          : "WAITING";

    if (status !== next) {
      assertWaitlistTransition(status, next);
    }

    await endWaitlistAssignments(transaction, {
      entryId,
      reason: tableIds.length > 0 ? "REPLACED" : "REMOVED",
      at: now,
    });
    await insertWaitlistAssignments(transaction, {
      entryId,
      locationId: actor.locationId,
      tableIds,
      userId: actor.userId,
      at: now,
    });

    return bumpEntry(transaction, entryId, { status: next });
  });
}

/**
 * `LEFT` when the party gave up waiting, `CANCELLED` for an explicit removal. A reservation
 * party goes back to its reservation. A walk-in's party is cancelled with it.
 */
export async function removeWaitlistEntry(
  database: Database,
  actor: Actor,
  entryId: string,
  input: { expectedVersion: number; outcome: "CANCELLED" | "LEFT"; reason?: string | null },
): Promise<Versioned> {
  assertPermission(actor, "waitlist.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const graph = await lockWaitlistEntry(
      transaction,
      actor,
      entryId,
      input.expectedVersion,
    );

    assertWaitlistTransition(
      graph.waitlistEntry.status as WaitlistStatus,
      input.outcome,
    );
    await endWaitlistAssignments(transaction, {
      entryId,
      reason: input.outcome,
      at: now,
    });

    if (graph.reservation) {
      await changePartyStatus(transaction, {
        party: graph.party,
        status: graph.reservation.status === "CHECKED_IN" ? "CHECKED_IN" : "EXPECTED",
        reason: "Left the waitlist",
        userId: actor.userId,
        occurredAt: now,
      });
    } else {
      await changePartyStatus(transaction, {
        party: graph.party,
        status: "CANCELLED",
        reason:
          blankToNull(input.reason) ??
          (input.outcome === "LEFT" ? "Left without being seated" : "Removed"),
        userId: actor.userId,
        occurredAt: now,
      });
    }

    return bumpEntry(transaction, entryId, {
      status: input.outcome,
      removedAt: now,
      removedByUserId: actor.userId,
    });
  });
}

export type WaitlistView = {
  id: string;
  version: number;
  guestPartyId: string;
  guestName: string;
  partySize: number;
  phone: string | null;
  hasSpecialRequests: boolean;
  specialRequests: string | null;
  status: WaitlistStatus;
  quotedWaitMinutes: number | null;
  preferredAreaId: string | null;
  addedAt: string;
  notifiedAt: string | null;
  seatedAt: string | null;
  notes: string | null;
  /** True when the party also has a reservation. */
  hasReservation: boolean;
  /** Tables the host picked. Planning only; nothing is occupied. */
  assignedTables: { id: string; tableNumber: string }[];
  /** Phase 21: the party's version, linked guest profile and this visit's allergies. */
  guest: PartyGuestView;
};

/** The open entries, oldest first, or the day's entries with `includeClosed`. */
export async function listWaitlist(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { includeClosedSince?: Date } = {},
): Promise<WaitlistView[]> {
  assertPermission(actor, "waitlist.view");

  const open: WaitlistStatus[] = ["WAITING", "NOTIFIED", "TABLE_ASSIGNED"];
  const rows = await executor
    .select({ entry: waitlistEntries, party: guestParties })
    .from(waitlistEntries)
    .innerJoin(guestParties, eq(guestParties.id, waitlistEntries.guestPartyId))
    .where(
      and(
        eq(waitlistEntries.locationId, actor.locationId),
        input.includeClosedSince
          ? undefined
          : inArray(waitlistEntries.status, open),
      ),
    )
    .orderBy(asc(waitlistEntries.addedAt), asc(waitlistEntries.id));
  const visible = input.includeClosedSince
    ? rows.filter(
        ({ entry }) =>
          open.includes(entry.status as WaitlistStatus) ||
          entry.addedAt >= input.includeClosedSince!,
      )
    : rows;
  const assignments = await activeWaitlistAssignments(
    executor,
    visible.map(({ entry }) => entry.id),
  );
  const reservationParties = new Set(
    visible.length
      ? (
          await executor
            .select({ partyId: reservations.guestPartyId })
            .from(reservations)
            .where(
              inArray(
                reservations.guestPartyId,
                visible.map(({ party }) => party.id),
              ),
            )
        ).map((row) => row.partyId)
      : [],
  );

  const guests = await loadPartyGuestFacts(
    executor,
    visible.map(({ party }) => party.id),
  );

  return visible.map(({ entry, party }) => ({
    id: entry.id,
    version: entry.version,
    guestPartyId: party.id,
    guest: { partyVersion: party.version, ...(guests.get(party.id) ?? { profile: null, allergies: [] }) },
    guestName: party.guestName,
    partySize: party.partySize,
    phone: party.phone,
    hasSpecialRequests: Boolean(party.specialRequests),
    specialRequests: party.specialRequests,
    status: entry.status as WaitlistStatus,
    quotedWaitMinutes: entry.quotedWaitMinutes,
    preferredAreaId: entry.preferredAreaId,
    addedAt: entry.addedAt.toISOString(),
    notifiedAt: entry.notifiedAt?.toISOString() ?? null,
    seatedAt: entry.seatedAt?.toISOString() ?? null,
    notes: entry.notes,
    hasReservation: reservationParties.has(party.id),
    assignedTables: assignments
      .filter((row) => row.entryId === entry.id)
      .map((row) => ({ id: row.tableId, tableNumber: row.tableNumber })),
  }));
}
