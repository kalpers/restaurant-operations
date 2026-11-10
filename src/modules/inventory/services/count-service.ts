import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryCountLines,
  inventoryCounts,
  inventoryItemLocations,
  inventoryItems,
  inventoryTransactions,
  unitsOfMeasure,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  assertApprovable,
  assertCountTransition,
  variance,
  variancePosting,
} from "../rules/counts";
import type { CountStatus } from "../types";
import { assertAnyPermission, assertPermission } from "./access";
import { latestSequence, lockBalance, postInventoryTransaction } from "./posting-service";

// Approved count policy: stock stays live while a count is open. Each line snapshots the
// expected quantity and the ledger sequence together, under the balance lock. Approval
// posts each variance (counted - expected) against current stock, never sets stock to the
// count, and requires acknowledgement if any ledger row arrived after a line's snapshot.

async function lockCount(
  transaction: DatabaseTransaction,
  actor: Actor,
  countId: string,
  expectedVersion: number,
) {
  const [count] = await transaction
    .select()
    .from(inventoryCounts)
    .where(
      and(
        eq(inventoryCounts.id, countId),
        eq(inventoryCounts.organizationId, actor.organizationId),
        eq(inventoryCounts.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!count) {
    throw new NotFoundError("inventory count");
  }

  if (count.version !== expectedVersion) {
    throw new ConcurrencyError("inventory count", countId);
  }

  return { ...count, status: count.status as CountStatus };
}

async function bumpCount(
  transaction: DatabaseTransaction,
  countId: string,
  values: Record<string, unknown>,
) {
  const [row] = await transaction
    .update(inventoryCounts)
    .set({ ...values, version: nextVersion(inventoryCounts.version), updatedAt: new Date() } as never)
    .where(eq(inventoryCounts.id, countId))
    .returning();

  return row!;
}

/**
 * Starts a count of the given items (default: every active item stocked here), capturing
 * each line's expected quantity and ledger position at that moment.
 */
export async function startCount(
  database: Database,
  actor: Actor,
  input: { name: string; inventoryItemIds: readonly string[] | null },
  now: Date = new Date(),
) {
  assertPermission(actor, "inventory.count");

  return withTransaction(database, async (transaction) => {
    const stocked = await transaction
      .select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId })
      .from(inventoryItemLocations)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryItemLocations.inventoryItemId))
      .where(
        and(
          eq(inventoryItemLocations.locationId, actor.locationId),
          eq(inventoryItemLocations.active, true),
          eq(inventoryItems.active, true),
          eq(inventoryItems.organizationId, actor.organizationId),
          input.inventoryItemIds ? inArray(inventoryItems.id, [...input.inventoryItemIds]) : undefined,
        ),
      );

    if (input.inventoryItemIds && stocked.length !== new Set(input.inventoryItemIds).size) {
      throw new BusinessRuleError(
        "ITEM_NOT_STOCKED_HERE",
        "Every counted item must be an active item stocked at this location.",
      );
    }

    if (stocked.length === 0) {
      throw new BusinessRuleError("NOTHING_TO_COUNT", "No active items are stocked here.");
    }

    const [count] = await transaction
      .insert(inventoryCounts)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        name: input.name,
        startedByUserId: actor.userId,
      })
      .returning();

    // Stable lock order, matching approval and postings.
    for (const item of [...stocked].sort((a, b) => a.id.localeCompare(b.id))) {
      const balance = await lockBalance(transaction, actor.organizationId, item.id, actor.locationId);

      await transaction.insert(inventoryCountLines).values({
        inventoryCountId: count!.id,
        inventoryItemId: item.id,
        unitOfMeasureId: item.baseUnitId,
        expectedQuantity: balance.quantityOnHand,
        snapshotSequence: await latestSequence(transaction, item.id, actor.locationId),
        snapshotAt: now,
      });
    }

    return count!;
  });
}

/** Enters a physical quantity (base unit). Nothing moves until approval. */
export async function recordCountLine(
  database: Database,
  actor: Actor,
  countId: string,
  lineId: string,
  input: { countedQuantity: string | null; notes: string | null; expectedVersion: number },
) {
  assertPermission(actor, "inventory.count");

  let counted: string | null = null;

  if (input.countedQuantity !== null) {
    try {
      counted = toScale(input.countedQuantity, 4);
    } catch {
      throw new BusinessRuleError(
        "INVALID_QUANTITY",
        "A counted quantity has at most four decimal places.",
      );
    }

    if (compareDecimals(counted, "0") < 0) {
      throw new BusinessRuleError("INVALID_QUANTITY", "A counted quantity can't be negative.");
    }
  }

  return withTransaction(database, async (transaction) => {
    const [line] = await transaction
      .select({ line: inventoryCountLines, status: inventoryCounts.status })
      .from(inventoryCountLines)
      .innerJoin(inventoryCounts, eq(inventoryCounts.id, inventoryCountLines.inventoryCountId))
      .where(
        and(
          eq(inventoryCountLines.id, lineId),
          eq(inventoryCountLines.inventoryCountId, countId),
          eq(inventoryCounts.organizationId, actor.organizationId),
          eq(inventoryCounts.locationId, actor.locationId),
        ),
      )
      .for("update");

    if (!line) {
      throw new NotFoundError("count line");
    }

    if (line.status !== "DRAFT") {
      throw new BusinessRuleError("COUNT_NOT_DRAFT", "Only a draft count can be edited.");
    }

    const rows = await transaction
      .update(inventoryCountLines)
      .set({
        countedQuantity: counted,
        varianceQuantity: counted === null ? null : variance(counted, line.line.expectedQuantity),
        notes: input.notes,
        version: nextVersion(inventoryCountLines.version),
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryCountLines.id, lineId), eq(inventoryCountLines.version, input.expectedVersion)))
      .returning();

    if (!rows[0]) {
      throw new ConcurrencyError("count line", lineId);
    }

    return rows[0];
  });
}

async function transition(
  database: Database,
  actor: Actor,
  countId: string,
  expectedVersion: number,
  to: CountStatus,
  values: Record<string, unknown>,
) {
  return withTransaction(database, async (transaction) => {
    const count = await lockCount(transaction, actor, countId, expectedVersion);

    assertCountTransition(count.status, to);

    return bumpCount(transaction, countId, { status: to, ...values });
  });
}

export function submitCount(
  database: Database,
  actor: Actor,
  countId: string,
  expectedVersion: number,
  now: Date = new Date(),
) {
  assertPermission(actor, "inventory.count");

  return transition(database, actor, countId, expectedVersion, "SUBMITTED", {
    submittedAt: now,
    submittedByUserId: actor.userId,
    countedAt: now,
  });
}

/** Sends a submitted count back for correction. */
export function returnCountToDraft(
  database: Database,
  actor: Actor,
  countId: string,
  expectedVersion: number,
) {
  assertPermission(actor, "inventory.count.approve");

  return transition(database, actor, countId, expectedVersion, "DRAFT", {
    submittedAt: null,
    submittedByUserId: null,
  });
}

export function cancelCount(
  database: Database,
  actor: Actor,
  countId: string,
  expectedVersion: number,
  now: Date = new Date(),
) {
  assertAnyPermission(actor, ["inventory.count", "inventory.count.approve"]);

  return transition(database, actor, countId, expectedVersion, "CANCELLED", {
    cancelledAt: now,
    cancelledByUserId: actor.userId,
  });
}

/**
 * Approves a submitted count and posts each non-zero variance as COUNT_INCREASE or
 * COUNT_DECREASE against current stock, atomically with the count's new state. Balances
 * are locked first, so no posting can slip in between the activity check and the posting.
 */
export async function approveCount(
  database: Database,
  actor: Actor,
  countId: string,
  input: { expectedVersion: number; acknowledgeActivity: boolean },
  now: Date = new Date(),
) {
  assertPermission(actor, "inventory.count.approve");

  return withTransaction(database, async (transaction) => {
    const count = await lockCount(transaction, actor, countId, input.expectedVersion);
    const lines = await transaction
      .select()
      .from(inventoryCountLines)
      .where(eq(inventoryCountLines.inventoryCountId, countId))
      .orderBy(asc(inventoryCountLines.inventoryItemId));
    let withActivity = 0;

    for (const line of lines) {
      await lockBalance(transaction, actor.organizationId, line.inventoryItemId, actor.locationId);

      if ((await latestSequence(transaction, line.inventoryItemId, actor.locationId)) > line.snapshotSequence) {
        withActivity += 1;
      }
    }

    assertApprovable({
      status: count.status,
      uncountedLines: lines.filter((line) => line.countedQuantity === null).length,
      linesWithActivity: withActivity,
      acknowledgeActivity: input.acknowledgeActivity,
    });

    let varianceCount = 0;

    for (const line of lines) {
      const posting = variancePosting(line.varianceQuantity!);

      if (!posting) {
        continue;
      }

      varianceCount += 1;

      const result = await postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: line.inventoryItemId,
        type: posting.type,
        quantity: posting.magnitude,
        unitOfMeasureId: line.unitOfMeasureId,
        occurredAt: now,
        reference: { type: "INVENTORY_COUNT", id: countId },
        notes: `Count variance: counted ${line.countedQuantity}, expected ${line.expectedQuantity}`,
        createdByUserId: actor.userId,
      });

      await transaction
        .update(inventoryCountLines)
        .set({
          inventoryTransactionId: result.transactionId,
          version: nextVersion(inventoryCountLines.version),
          updatedAt: new Date(),
        })
        .where(eq(inventoryCountLines.id, line.id));
    }

    const approved = await bumpCount(transaction, countId, {
      status: "APPROVED",
      approvedAt: now,
      approvedByUserId: actor.userId,
      ...(withActivity > 0
        ? { activityAcknowledgedAt: now, activityAcknowledgedByUserId: actor.userId }
        : {}),
    });

    await recordAudit(transaction, actor, {
      action: "inventory.count-approved",
      entityId: countId,
      occurredAt: now,
      before: { status: count.status },
      after: { status: "APPROVED", lineCount: lines.length, varianceCount },
    });

    return approved;
  });
}

export async function listCounts(executor: DatabaseExecutor, actor: Actor) {
  assertAnyPermission(actor, ["inventory.count", "inventory.count.approve", "inventory.view"]);

  return executor
    .select()
    .from(inventoryCounts)
    .where(
      and(
        eq(inventoryCounts.organizationId, actor.organizationId),
        eq(inventoryCounts.locationId, actor.locationId),
      ),
    )
    .orderBy(desc(inventoryCounts.createdAt));
}

/** A count with its lines and, per line, whether stock has moved since the snapshot. */
export async function getCount(executor: DatabaseExecutor, actor: Actor, countId: string) {
  assertAnyPermission(actor, ["inventory.count", "inventory.count.approve", "inventory.view"]);

  const [count] = await executor
    .select()
    .from(inventoryCounts)
    .where(
      and(
        eq(inventoryCounts.id, countId),
        eq(inventoryCounts.organizationId, actor.organizationId),
        eq(inventoryCounts.locationId, actor.locationId),
      ),
    );

  if (!count) {
    throw new NotFoundError("inventory count");
  }

  const lines = await executor
    .select({
      line: inventoryCountLines,
      itemName: inventoryItems.name,
      itemCode: inventoryItems.code,
      unitCode: unitsOfMeasure.code,
      latest: sql<string | null>`(
        SELECT max(${inventoryTransactions.sequence}) FROM ${inventoryTransactions}
        WHERE ${inventoryTransactions.inventoryItemId} = ${inventoryCountLines.inventoryItemId}
          AND ${inventoryTransactions.locationId} = ${count.locationId}
      )`,
    })
    .from(inventoryCountLines)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryCountLines.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryCountLines.unitOfMeasureId))
    .where(eq(inventoryCountLines.inventoryCountId, countId))
    .orderBy(asc(inventoryItems.name));

  return {
    count,
    lines: lines.map(({ line, itemName, itemCode, unitCode, latest }) => ({
      ...line,
      itemName,
      itemCode,
      unitCode,
      activitySinceSnapshot:
        count.status !== "APPROVED" && count.status !== "CANCELLED" && Number(latest ?? 0) > line.snapshotSequence,
    })),
  };
}
