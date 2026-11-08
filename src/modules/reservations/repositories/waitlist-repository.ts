import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import {
  restaurantTables,
  waitlistTableAssignments,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

export async function activeWaitlistAssignments(
  executor: DatabaseExecutor,
  entryIds: readonly string[],
) {
  if (entryIds.length === 0) {
    return [];
  }

  return executor
    .select({
      entryId: waitlistTableAssignments.waitlistEntryId,
      tableId: waitlistTableAssignments.restaurantTableId,
      tableNumber: restaurantTables.tableNumber,
    })
    .from(waitlistTableAssignments)
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, waitlistTableAssignments.restaurantTableId),
    )
    .where(
      and(
        inArray(waitlistTableAssignments.waitlistEntryId, [...entryIds]),
        isNull(waitlistTableAssignments.removedAt),
      ),
    )
    .orderBy(asc(restaurantTables.tableNumber));
}

/** Ends the planned selection and keeps the rows as history. */
export async function endWaitlistAssignments(
  transaction: DatabaseTransaction,
  input: {
    entryId: string;
    reason: "REPLACED" | "SEATED" | "CANCELLED" | "LEFT" | "REMOVED";
    at: Date;
    tableIds?: readonly string[];
  },
): Promise<void> {
  await transaction
    .update(waitlistTableAssignments)
    .set({ removedAt: input.at, removalReason: input.reason })
    .where(
      and(
        eq(waitlistTableAssignments.waitlistEntryId, input.entryId),
        isNull(waitlistTableAssignments.removedAt),
        input.tableIds
          ? inArray(
              waitlistTableAssignments.restaurantTableId,
              [...input.tableIds],
            )
          : undefined,
      ),
    );
}

export async function insertWaitlistAssignments(
  transaction: DatabaseTransaction,
  input: {
    entryId: string;
    locationId: string;
    tableIds: readonly string[];
    userId: string;
    at: Date;
  },
): Promise<void> {
  if (input.tableIds.length === 0) {
    return;
  }

  await transaction.insert(waitlistTableAssignments).values(
    input.tableIds.map((restaurantTableId) => ({
      waitlistEntryId: input.entryId,
      locationId: input.locationId,
      restaurantTableId,
      assignedByUserId: input.userId,
      assignedAt: input.at,
    })),
  );
}
