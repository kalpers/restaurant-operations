import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { tableSessions } from "@/db/schema";
import {
  withTransaction,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
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
 * Seats a party. Tables are locked before anything depending on them is read, so two hosts
 * can't take the same table, and a failure at any step leaves nothing behind. The unique
 * index on open memberships is the last line of defence. Phase 6 extends this with the
 * Guest Party.
 */
export async function seatParty(
  database: Database,
  actor: Actor,
  input: SeatPartyInput,
): Promise<SeatPartyResult> {
  assertPermission(actor, "restaurant.seat");

  if (input.serverEmployeeId) {
    assertPermission(actor, "restaurant.server.assign");
  }

  const tableIds = [...new Set(input.tableIds)];

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const tables = await lockTablesAtLocation(
        transaction,
        actor.locationId,
        tableIds,
      );

      await assertTablesSeatable(transaction, tables);

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

      return {
        id: session!.id,
        version: session!.version,
        assignedServerEmployeeId: serverEmployeeId,
        warnings,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        "One of those tables was just seated. Refresh the floor and try again.",
      );
    }

    throw error;
  }
}
