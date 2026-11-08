import type { Database } from "@/db";
import {
  isUniqueViolation,
  readConstraintName,
} from "@/db/helpers/database-errors";
import { tableSessions } from "@/db/schema";
import {
  withTransaction,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  checkHoldsForSeating,
  recordHoldOverrides,
} from "@/modules/reservations/services/hold-service";
import {
  findSectionServers,
  openMemberships,
  recordCapacityOverride,
  recordScheduleOverride,
} from "@/modules/restaurant/repositories/session-repository";
import {
  assertPermission,
  readLocationClock,
} from "@/modules/restaurant/services/access";
import {
  assertOneArea,
  assertTablesSeatable,
  checkCapacity,
  lockTablesAtLocation,
} from "@/modules/restaurant/services/seating-checks";
import {
  checkServerAssignment,
  isServerAssignableWithoutOverride,
} from "@/modules/restaurant/services/server-eligibility-service";
import type { AreaType } from "@/modules/restaurant/types";
import { ConflictError } from "@/shared/errors/app-error";

export type SeatPartyInput = {
  tableIds: readonly string[];
  partySize: number;
  /** Left out, it uses the section's server. Null seats the party with no server. */
  serverEmployeeId?: string | null;
  capacityOverrideReason?: string | null;
  scheduleOverrideReason?: string | null;
  /** Needed, with `reservations.override-hold`, to take a table held for another party. */
  holdOverrideReason?: string | null;
  /** The Guest Party being seated. A party can have only one active session. */
  guestPartyId?: string | null;
  notes?: string | null;
};

export type SeatPartyResult = {
  id: string;
  version: number;
  assignedServerEmployeeId: string | null;
  warnings: string[];
};

/**
 * The section's server, only if every table points to the same person and that person
 * needs no override. A default is a convenience, so it never fails the seating.
 */
async function resolveSectionDefault(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: {
    tableIds: readonly string[];
    areaType: AreaType;
    businessDate: string;
    instant: Date;
  },
): Promise<{ employeeId: string | null; warnings: string[] }> {
  const servers = await findSectionServers(transaction, {
    tableIds: input.tableIds,
    businessDate: input.businessDate,
  });

  if (servers.size === 0) {
    return { employeeId: null, warnings: [] };
  }

  const distinct = new Set(servers.values());
  const [employeeId] = distinct;

  if (
    distinct.size === 1 &&
    servers.size === input.tableIds.length &&
    employeeId &&
    (await isServerAssignableWithoutOverride(transaction, actor, {
      employeeId,
      areaTypes: [input.areaType],
      instant: input.instant,
    }))
  ) {
    return { employeeId, warnings: [] };
  }

  return { employeeId: null, warnings: ["SECTION_SERVER_NOT_APPLIED"] };
}

/**
 * Seats a party in a transaction of its own. Use `seatPartyInTransaction` to seat as part
 * of a larger unit of work, such as seating a reservation or a waitlist entry.
 */
export async function seatParty(
  database: Database,
  actor: Actor,
  input: SeatPartyInput,
): Promise<SeatPartyResult> {
  assertSeatPermissions(actor, input);

  try {
    return await withTransaction(database, (transaction) =>
      seatPartyInTransaction(transaction, actor, input),
    );
  } catch (error) {
    throw mapSeatingViolation(error);
  }
}

function assertSeatPermissions(actor: Actor, input: SeatPartyInput): void {
  assertPermission(actor, "restaurant.seat");

  if (input.serverEmployeeId) {
    assertPermission(actor, "restaurant.server.assign");
  }
}

/** Which unique index fired decides what the host is told. */
export function mapSeatingViolation(error: unknown): unknown {
  if (!isUniqueViolation(error)) {
    return error;
  }

  return readConstraintName(error) ===
    "table_sessions_one_active_per_guest_party_unique"
    ? new ConflictError(
        "PARTY_ALREADY_SEATED",
        "This party was just seated. Refresh and check the floor.",
      )
    : new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        "One of those tables was just seated. Refresh the floor and try again.",
      );
}

/**
 * Seats a party. Tables are locked before anything depending on them is read, so two hosts
 * can't take the same table, and a failure at any step leaves nothing behind. The unique
 * indexes on open memberships and on a party's active session are the last line of defence.
 * Reservation holds are checked after the Phase 5 rules, which they never bypass.
 */
export async function seatPartyInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: SeatPartyInput,
): Promise<SeatPartyResult> {
  assertSeatPermissions(actor, input);

  const tableIds = [...new Set(input.tableIds)];

  const now = new Date();
  const tables = await lockTablesAtLocation(
    transaction,
    actor.locationId,
    tableIds,
  );

  await assertTablesSeatable(transaction, tables);

  const holds = await checkHoldsForSeating(transaction, actor, {
    tableIds,
    guestPartyId: input.guestPartyId,
    overrideReason: input.holdOverrideReason,
    now,
  });
  const areaType = assertOneArea(tables);
  const capacity = checkCapacity(actor, {
    partySize: input.partySize,
    tables,
    overrideReason: input.capacityOverrideReason,
  });

  let serverEmployeeId = input.serverEmployeeId ?? null;
  let scheduleOverrideReason: string | null = null;
  let warnings: string[] = [];

  if (serverEmployeeId) {
    ({ scheduleOverrideReason } = await checkServerAssignment(
      transaction,
      actor,
      {
        employeeId: serverEmployeeId,
        areaTypes: [areaType],
        overrideReason: input.scheduleOverrideReason,
        instant: now,
      },
    ));
  } else if (input.serverEmployeeId === undefined) {
    const clock = await readLocationClock(
      transaction,
      actor.locationId,
      now,
    );
    const fallback = await resolveSectionDefault(transaction, actor, {
      tableIds,
      areaType,
      businessDate: clock.businessDate,
      instant: now,
    });

    serverEmployeeId = fallback.employeeId;
    warnings = fallback.warnings;
  }

  const [session] = await transaction
    .insert(tableSessions)
    .values({
      locationId: actor.locationId,
      guestPartyId: input.guestPartyId ?? null,
      partySize: input.partySize,
      assignedServerEmployeeId: serverEmployeeId,
      seatedAt: now,
      createdByUserId: actor.userId,
      notes: input.notes ?? null,
    })
    .returning({ id: tableSessions.id, version: tableSessions.version });

  await openMemberships(transaction, {
    sessionId: session!.id,
    locationId: actor.locationId,
    tableIds,
    joinedAt: now,
  });

  if (capacity.overrideReason) {
    await recordCapacityOverride(transaction, {
      sessionId: session!.id,
      reason: capacity.overrideReason,
      userId: actor.userId,
      partySize: input.partySize,
      seatedCapacity: capacity.capacity,
      occurredAt: now,
    });
  }

  if (scheduleOverrideReason && serverEmployeeId) {
    await recordScheduleOverride(transaction, {
      sessionId: session!.id,
      reason: scheduleOverrideReason,
      userId: actor.userId,
      serverEmployeeId,
      occurredAt: now,
    });
  }

  if (holds.reason) {
    await recordHoldOverrides(transaction, actor, {
      sessionId: session!.id,
      holds: holds.overridden,
      reason: holds.reason,
      occurredAt: now,
    });
  }

  return {
    id: session!.id,
    version: session!.version,
    assignedServerEmployeeId: serverEmployeeId,
    warnings,
  };
}
