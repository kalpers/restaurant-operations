import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import { tableSessions } from "@/db/schema";
import {
  withTransaction,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  endMemberships,
  findOpenMemberships,
  lockSession,
  openMemberships,
  recordCapacityOverride,
  recordScheduleOverride,
} from "../repositories/session-repository";
import {
  writeTableCondition,
  type TableRow,
} from "../repositories/table-repository";
import { assertPermission } from "./access";
import {
  assertOneArea,
  assertTablesSeatable,
  checkCapacity,
  lockTablesAtLocation,
} from "./seating-checks";
import {
  checkServerAssignment,
  isServerQualifiedFor,
} from "./server-eligibility-service";

type SessionRow = NonNullable<Awaited<ReturnType<typeof lockSession>>>;
type Versioned = { id: string; version: number };

/** Locks the session, at the expected version and still active. */
async function lockActiveSession(
  transaction: DatabaseTransaction,
  actor: Actor,
  sessionId: string,
  expectedVersion: number,
): Promise<SessionRow> {
  const session = await lockSession(transaction, sessionId, actor.locationId);

  if (!session) {
    throw new NotFoundError("table session");
  }

  if (session.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "SESSION_NOT_ACTIVE",
      "This table session has already ended.",
    );
  }

  if (session.version !== expectedVersion) {
    throw new ConcurrencyError("table session", session.id);
  }

  return session;
}

async function currentTableIds(
  transaction: DatabaseTransaction,
  sessionId: string,
): Promise<string[]> {
  const rows = await findOpenMemberships(transaction, [sessionId]);

  return rows.map((row) => row.tableId);
}

async function bumpSession(
  transaction: DatabaseTransaction,
  sessionId: string,
  changes: Partial<typeof tableSessions.$inferInsert> = {},
): Promise<Versioned> {
  const [row] = await transaction
    .update(tableSessions)
    .set({ ...changes, version: nextVersion(tableSessions.version) })
    .where(eq(tableSessions.id, sessionId))
    .returning({ id: tableSessions.id, version: tableSessions.version });

  return row!;
}

/** A table the party used needs cleaning, whatever the reason they left it. */
async function markUsedTablesDirty(
  transaction: DatabaseTransaction,
  actor: Actor,
  tableIds: readonly string[],
  reason: string,
  occurredAt: Date,
): Promise<void> {
  for (const tableId of tableIds) {
    await writeTableCondition(transaction, {
      tableId,
      condition: "DIRTY",
      reason,
      userId: actor.userId,
      occurredAt,
    });
  }
}

/** The unique index can only fire here if a concurrent writer slipped past the locks. */
function mapOccupancyViolation(error: unknown): unknown {
  return isUniqueViolation(error)
    ? new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        "One of those tables was just seated. Refresh the floor and try again.",
      )
    : error;
}

/** A server stays only if qualified for the area the party is going to. */
async function assertServerSuitsArea(
  transaction: DatabaseTransaction,
  actor: Actor,
  session: SessionRow,
  tables: readonly TableRow[],
  instant: Date,
): Promise<void> {
  if (
    session.assignedServerEmployeeId &&
    !(await isServerQualifiedFor(transaction, actor, {
      employeeId: session.assignedServerEmployeeId,
      areaTypes: [assertOneArea(tables)],
      instant,
    }))
  ) {
    throw new BusinessRuleError(
      "SERVER_NOT_QUALIFIED_FOR_AREA",
      "The assigned server can't work that area. Reassign the server first.",
    );
  }
}

/**
 * Moves a party to a target set of tables as one change. Tables in both sets stay, tables
 * left behind become DIRTY because they were used, and it's the same session throughout.
 */
export async function moveSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: {
    tableIds: readonly string[];
    capacityOverrideReason?: string | null;
    expectedVersion: number;
  },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.move");

  const targetIds = [...new Set(input.tableIds)];

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const session = await lockActiveSession(
      transaction,
      actor,
      sessionId,
      input.expectedVersion,
    );
    const currentIds = await currentTableIds(transaction, sessionId);
    const vacatedIds = currentIds.filter((id) => !targetIds.includes(id));
    const newIds = targetIds.filter((id) => !currentIds.includes(id));

    if (vacatedIds.length === 0 && newIds.length === 0) {
      throw new BusinessRuleError(
        "SESSION_TABLES_UNCHANGED",
        "The party is already at those tables.",
      );
    }

    const locked = await lockTablesAtLocation(transaction, actor.locationId, [
      ...currentIds,
      ...newIds,
    ]);
    const targets = locked.filter((table) => targetIds.includes(table.id));

    await assertTablesSeatable(
      transaction,
      targets.filter((table) => newIds.includes(table.id)),
    );
    assertOneArea(targets);
    await assertServerSuitsArea(transaction, actor, session, targets, now);

    const capacity = checkCapacity(actor, {
      partySize: session.partySize,
      tables: targets,
      overrideReason: input.capacityOverrideReason,
    });

    await endMemberships(transaction, {
      sessionId,
      tableIds: vacatedIds,
      leftAt: now,
    });
    await markUsedTablesDirty(transaction, actor, vacatedIds, "Party moved", now);
    await openMemberships(transaction, {
      sessionId,
      locationId: actor.locationId,
      tableIds: newIds,
      joinedAt: now,
    });

    if (capacity.overrideReason) {
      await recordCapacityOverride(transaction, {
        sessionId,
        reason: capacity.overrideReason,
        userId: actor.userId,
        partySize: session.partySize,
        seatedCapacity: capacity.capacity,
        occurredAt: now,
      });
    }

    return bumpSession(transaction, sessionId);
  }).catch((error: unknown) => {
    throw mapOccupancyViolation(error);
  });
}

/** Combines another table into a session. It must be clean, free and in the same area. */
export async function addTableToSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: {
    tableId: string;
    capacityOverrideReason?: string | null;
    expectedVersion: number;
  },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.move");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const session = await lockActiveSession(
      transaction,
      actor,
      sessionId,
      input.expectedVersion,
    );
    const currentIds = await currentTableIds(transaction, sessionId);

    if (currentIds.includes(input.tableId)) {
      throw new BusinessRuleError(
        "SESSION_TABLES_UNCHANGED",
        "That table is already part of this session.",
      );
    }

    const tables = await lockTablesAtLocation(transaction, actor.locationId, [
      ...currentIds,
      input.tableId,
    ]);

    await assertTablesSeatable(
      transaction,
      tables.filter((table) => table.id === input.tableId),
    );
    assertOneArea(tables);

    const capacity = checkCapacity(actor, {
      partySize: session.partySize,
      tables,
      overrideReason: input.capacityOverrideReason,
    });

    await openMemberships(transaction, {
      sessionId,
      locationId: actor.locationId,
      tableIds: [input.tableId],
      joinedAt: now,
    });

    if (capacity.overrideReason) {
      await recordCapacityOverride(transaction, {
        sessionId,
        reason: capacity.overrideReason,
        userId: actor.userId,
        partySize: session.partySize,
        seatedCapacity: capacity.capacity,
        occurredAt: now,
      });
    }

    return bumpSession(transaction, sessionId);
  }).catch((error: unknown) => {
    throw mapOccupancyViolation(error);
  });
}

/** Takes one table out of a combination. The table becomes DIRTY; its row stays. */
export async function removeTableFromSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  tableId: string,
  input: { capacityOverrideReason?: string | null; expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.move");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const session = await lockActiveSession(
      transaction,
      actor,
      sessionId,
      input.expectedVersion,
    );
    const currentIds = await currentTableIds(transaction, sessionId);

    if (!currentIds.includes(tableId)) {
      throw new NotFoundError("table in this session");
    }

    if (currentIds.length === 1) {
      throw new BusinessRuleError(
        "SESSION_NEEDS_A_TABLE",
        "A session's last table can't be removed. Move or complete the session instead.",
      );
    }

    const tables = await lockTablesAtLocation(
      transaction,
      actor.locationId,
      currentIds,
    );
    const remaining = tables.filter((table) => table.id !== tableId);
    const capacity = checkCapacity(actor, {
      partySize: session.partySize,
      tables: remaining,
      overrideReason: input.capacityOverrideReason,
    });

    await endMemberships(transaction, {
      sessionId,
      tableIds: [tableId],
      leftAt: now,
    });
    await markUsedTablesDirty(
      transaction,
      actor,
      [tableId],
      "Removed from session",
      now,
    );

    if (capacity.overrideReason) {
      await recordCapacityOverride(transaction, {
        sessionId,
        reason: capacity.overrideReason,
        userId: actor.userId,
        partySize: session.partySize,
        seatedCapacity: capacity.capacity,
        occurredAt: now,
      });
    }

    return bumpSession(transaction, sessionId);
  });
}

/**
 * Assigns or clears the session's server, separately from section configuration, which
 * this never touches. The employee needs no login.
 */
export async function assignSessionServer(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: {
    serverEmployeeId: string | null;
    scheduleOverrideReason?: string | null;
    expectedVersion: number;
  },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.server.assign");

  return withTransaction(database, async (transaction) => {
    const now = new Date();

    await lockActiveSession(transaction, actor, sessionId, input.expectedVersion);

    if (input.serverEmployeeId) {
      const tables = await lockTablesAtLocation(
        transaction,
        actor.locationId,
        await currentTableIds(transaction, sessionId),
      );
      const { scheduleOverrideReason } = await checkServerAssignment(
        transaction,
        actor,
        {
          employeeId: input.serverEmployeeId,
          areaTypes: [assertOneArea(tables)],
          overrideReason: input.scheduleOverrideReason,
          instant: now,
        },
      );

      if (scheduleOverrideReason) {
        await recordScheduleOverride(transaction, {
          sessionId,
          reason: scheduleOverrideReason,
          userId: actor.userId,
          serverEmployeeId: input.serverEmployeeId,
          occurredAt: now,
        });
      }
    }

    return bumpSession(transaction, sessionId, {
      assignedServerEmployeeId: input.serverEmployeeId,
    });
  });
}

/**
 * Guests have left: ends the session and marks every table it holds DIRTY, in one
 * transaction. Phase 9 adds its open-order precondition here, after the session is locked.
 */
export async function completeSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.complete-session");

  return withTransaction(database, async (transaction) => {
    const now = new Date();

    await lockActiveSession(transaction, actor, sessionId, input.expectedVersion);

    const tableIds = await currentTableIds(transaction, sessionId);

    await lockTablesAtLocation(transaction, actor.locationId, tableIds);
    await endMemberships(transaction, { sessionId, tableIds, leftAt: now });
    await markUsedTablesDirty(
      transaction,
      actor,
      tableIds,
      "Session completed",
      now,
    );

    return bumpSession(transaction, sessionId, {
      status: "COMPLETED",
      completedAt: now,
      completedByUserId: actor.userId,
    });
  });
}

/**
 * For a seating made by mistake, before the tables were really used. Its tables stay as
 * they are. A table that was used goes through completion, so it gets cleaned.
 */
export async function cancelSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { reason: string; expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "restaurant.cancel-session");

  return withTransaction(database, async (transaction) => {
    const now = new Date();

    await lockActiveSession(transaction, actor, sessionId, input.expectedVersion);

    const tableIds = await currentTableIds(transaction, sessionId);

    await lockTablesAtLocation(transaction, actor.locationId, tableIds);
    await endMemberships(transaction, { sessionId, tableIds, leftAt: now });

    return bumpSession(transaction, sessionId, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
  });
}
