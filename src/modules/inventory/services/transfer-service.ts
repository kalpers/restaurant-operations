import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  inventoryItemLocations,
  inventoryItems,
  inventoryTransactions,
  inventoryTransferLines,
  inventoryTransfers,
  locations,
  locationSettings,
  unitsOfMeasure,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, isPositiveDecimal, subtractDecimals } from "@/shared/decimal/decimal";
import { AuthorizationError, BusinessRuleError, NotFoundError, ValidationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { loadConversionContext, requireItemFacts } from "../repositories/conversion-repository";
import { extendCost } from "../rules/costing";
import { toBaseQuantity } from "../rules/unit-resolution";
import { assertPermission, canSeeCost } from "./access";
import { lockBalance, postInventoryTransaction } from "./posting-service";

// Phase 23 (policies 10–15, D7): transfers between locations as a record. A DRAFT is
// built at the sending location; sending posts TRANSFER_OUT for every line and freezes each
// line's average cost; the stock is then in transit; receiving at the other location posts
// TRANSFER_IN for the full sent quantity at the frozen cost and, for any line that arrived
// short, an ADJUST_DECREASE with reason TRANSFER_SHORTAGE. Each pair nets to zero and every
// loss is in the ledger. All postings go through the posting service.

export const TRANSFER_REFERENCE = "INVENTORY_TRANSFER";
export const SEND_SCOPE = "inventory.transfer-send";
export const RECEIVE_SCOPE = "inventory.transfer-receive";
export const TRANSFER_NOW_SCOPE = "inventory.transfer-now";

export type TransferLineInput = { inventoryItemId: string; quantity: string; unitOfMeasureId: string; lotId?: string | null };

export function formatTransferNumber(sequence: number): string {
  return `TR-${String(sequence).padStart(6, "0")}`;
}

async function assertTransferAllowedAt(database: Database | DatabaseExecutor, actor: Actor, locationId: string) {
  if (
    locationId !== actor.locationId &&
    !(await userHasPermission(database as Database, {
      userId: actor.userId,
      permission: "inventory.transfer",
      locationId,
    }))
  ) {
    throw new AuthorizationError();
  }
}

async function requireActiveDestination(transaction: DatabaseTransaction, actor: Actor, toLocationId: string) {
  if (toLocationId === actor.locationId) {
    throw new BusinessRuleError("SAME_LOCATION", "Choose a different location to transfer to.");
  }

  const [row] = await transaction
    .select({ active: locations.active })
    .from(locations)
    .where(and(eq(locations.id, toLocationId), eq(locations.organizationId, actor.organizationId)));

  if (!row) {
    throw new NotFoundError("location");
  }

  if (!row.active) {
    throw new BusinessRuleError("LOCATION_INACTIVE", "That location is closed.");
  }
}

async function buildLines(transaction: DatabaseTransaction, actor: Actor, lines: readonly TransferLineInput[]) {
  if (lines.length === 0) {
    throw new ValidationError("Add at least one item to the transfer.");
  }

  if (new Set(lines.map((line) => line.inventoryItemId)).size !== lines.length) {
    throw new ValidationError("List each item once.");
  }

  const built = [];

  for (const line of lines) {
    if (!isPositiveDecimal(line.quantity)) {
      throw new BusinessRuleError("INVALID_QUANTITY", "Enter a quantity greater than zero.");
    }

    const item = await requireItemFacts(transaction, actor.organizationId, line.inventoryItemId);
    const context = await loadConversionContext(transaction, item.id);
    const baseQuantity = toBaseQuantity(context, line.quantity, line.unitOfMeasureId, item.baseUnitId);

    if (!isPositiveDecimal(baseQuantity)) {
      throw new BusinessRuleError("INVALID_QUANTITY", "That quantity is too small to record.");
    }

    built.push({ ...line, baseQuantity, baseUnitId: item.baseUnitId });
  }

  return built;
}

async function lockTransfer(transaction: DatabaseTransaction, actor: Actor, transferId: string, expectedVersion: number) {
  const [row] = await transaction
    .select()
    .from(inventoryTransfers)
    .where(and(eq(inventoryTransfers.id, transferId), eq(inventoryTransfers.organizationId, actor.organizationId)))
    .for("update");

  if (!row) {
    throw new NotFoundError("transfer");
  }

  if (row.version !== expectedVersion) {
    throw new ConcurrencyError("transfer", transferId);
  }

  return row;
}

async function bumpTransfer(transaction: DatabaseTransaction, transferId: string, changes: Partial<typeof inventoryTransfers.$inferInsert>) {
  const [row] = await transaction
    .update(inventoryTransfers)
    .set({ ...changes, version: sql`${inventoryTransfers.version} + 1`, updatedAt: new Date() })
    .where(eq(inventoryTransfers.id, transferId))
    .returning({ id: inventoryTransfers.id, version: inventoryTransfers.version, status: inventoryTransfers.status });

  return row!;
}

async function transferLines(executor: DatabaseExecutor, transferId: string) {
  return executor
    .select()
    .from(inventoryTransferLines)
    .where(eq(inventoryTransferLines.transferId, transferId))
    .orderBy(asc(inventoryTransferLines.inventoryItemId));
}

/** Creates a DRAFT at the actor's location. */
export async function createTransfer(
  database: Database,
  actor: Actor,
  input: { toLocationId: string; notes: string | null; lines: readonly TransferLineInput[] },
) {
  assertPermission(actor, "inventory.transfer");

  return withTransaction(database, (transaction) => createTransferIn(transaction, actor, input));
}

async function createTransferIn(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: { toLocationId: string; notes: string | null; lines: readonly TransferLineInput[] },
) {
  await requireActiveDestination(transaction, actor, input.toLocationId);
  const lines = await buildLines(transaction, actor, input.lines);

  // Numbers are allocated one at a time per sending location.
  await transaction
    .select({ locationId: locationSettings.locationId })
    .from(locationSettings)
    .where(eq(locationSettings.locationId, actor.locationId))
    .for("update");
  const [last] = await transaction
    .select({ value: sql<number | null>`max(${inventoryTransfers.sequenceNumber})` })
    .from(inventoryTransfers)
    .where(eq(inventoryTransfers.fromLocationId, actor.locationId));
  const sequenceNumber = Number(last?.value ?? 0) + 1;
  const [transfer] = await transaction
    .insert(inventoryTransfers)
    .values({
      organizationId: actor.organizationId,
      fromLocationId: actor.locationId,
      toLocationId: input.toLocationId,
      sequenceNumber,
      transferNumber: formatTransferNumber(sequenceNumber),
      notes: input.notes,
      createdByUserId: actor.userId,
    })
    .returning();

  await transaction.insert(inventoryTransferLines).values(
    lines.map((line) => ({
      transferId: transfer!.id,
      inventoryItemId: line.inventoryItemId,
      quantity: line.quantity,
      unitOfMeasureId: line.unitOfMeasureId,
      baseQuantity: line.baseQuantity,
      lotId: line.lotId ?? null,
    })),
  );

  return { id: transfer!.id, transferNumber: transfer!.transferNumber, version: transfer!.version };
}

/** Replaces a DRAFT's destination, notes and lines. Sender only. */
export async function updateDraftTransfer(
  database: Database,
  actor: Actor,
  transferId: string,
  input: { toLocationId: string; notes: string | null; lines: readonly TransferLineInput[]; expectedVersion: number },
) {
  assertPermission(actor, "inventory.transfer");

  return withTransaction(database, async (transaction) => {
    const transfer = await lockTransfer(transaction, actor, transferId, input.expectedVersion);

    if (transfer.fromLocationId !== actor.locationId) {
      throw new AuthorizationError();
    }

    if (transfer.status !== "DRAFT") {
      throw new BusinessRuleError("TRANSFER_NOT_DRAFT", "Only a draft transfer can be changed.");
    }

    await requireActiveDestination(transaction, actor, input.toLocationId);
    const lines = await buildLines(transaction, actor, input.lines);

    await transaction.delete(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, transferId));
    await transaction.insert(inventoryTransferLines).values(
      lines.map((line) => ({
        transferId,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unitOfMeasureId: line.unitOfMeasureId,
        baseQuantity: line.baseQuantity,
        lotId: line.lotId ?? null,
      })),
    );

    return bumpTransfer(transaction, transferId, { toLocationId: input.toLocationId, notes: input.notes });
  });
}

/** Cancels a DRAFT. A sent transfer can't be cancelled: send a transfer back instead. */
export async function cancelTransfer(database: Database, actor: Actor, transferId: string, expectedVersion: number) {
  assertPermission(actor, "inventory.transfer");

  return withTransaction(database, async (transaction) => {
    const transfer = await lockTransfer(transaction, actor, transferId, expectedVersion);

    if (transfer.fromLocationId !== actor.locationId) {
      throw new AuthorizationError();
    }

    if (transfer.status !== "DRAFT") {
      throw new BusinessRuleError(
        "TRANSFER_NOT_DRAFT",
        "Only a draft can be cancelled. To undo a sent transfer, send the stock back.",
      );
    }

    const result = await bumpTransfer(transaction, transferId, {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: actor.userId,
    });

    await recordAudit(transaction, actor, {
      action: "inventory.transfer-cancelled",
      entityId: transferId,
      after: { transferNumber: transfer.transferNumber, status: "CANCELLED" },
    });

    return result;
  });
}

async function sendIn(transaction: DatabaseTransaction, actor: Actor, transferId: string, expectedVersion: number, now: Date) {
  const transfer = await lockTransfer(transaction, actor, transferId, expectedVersion);

  if (transfer.fromLocationId !== actor.locationId) {
    throw new AuthorizationError();
  }

  if (transfer.status !== "DRAFT") {
    throw new BusinessRuleError("TRANSFER_NOT_DRAFT", "This transfer was already sent or cancelled.");
  }

  await requireActiveDestination(transaction, actor, transfer.toLocationId);
  const lines = await transferLines(transaction, transferId);
  const stockedThere = await transaction
    .select({ inventoryItemId: inventoryItemLocations.inventoryItemId })
    .from(inventoryItemLocations)
    .where(
      and(
        eq(inventoryItemLocations.locationId, transfer.toLocationId),
        eq(inventoryItemLocations.active, true),
        inArray(inventoryItemLocations.inventoryItemId, lines.map((line) => line.inventoryItemId)),
      ),
    );

  if (stockedThere.length !== lines.length) {
    throw new BusinessRuleError(
      "ITEM_NOT_STOCKED_HERE",
      "The receiving location doesn't stock every item on this transfer.",
    );
  }

  // Lock the sender's balances in a stable order, so concurrent sends can't deadlock.
  for (const line of lines) {
    await lockBalance(transaction, actor.organizationId, line.inventoryItemId, actor.locationId);
  }

  for (const line of lines) {
    const facts = await requireItemFacts(transaction, actor.organizationId, line.inventoryItemId);
    const out = await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      inventoryItemId: line.inventoryItemId,
      type: "TRANSFER_OUT",
      quantity: line.baseQuantity,
      unitOfMeasureId: facts.baseUnitId,
      reference: { type: TRANSFER_REFERENCE, id: transferId },
      notes: transfer.transferNumber,
      occurredAt: now,
      createdByUserId: actor.userId,
      lot: { lotId: line.lotId },
    });

    await transaction
      .update(inventoryTransferLines)
      .set({ unitCostSent: out.unitCost, updatedAt: now })
      .where(eq(inventoryTransferLines.id, line.id));
  }

  const result = await bumpTransfer(transaction, transferId, { status: "SENT", sentAt: now, sentByUserId: actor.userId });

  await recordAudit(transaction, actor, {
    action: "inventory.transfer-sent",
    entityId: transferId,
    after: { transferNumber: transfer.transferNumber, toLocationId: transfer.toLocationId, lineCount: lines.length },
  });
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: transfer.toLocationId,
      eventType: "inventory.transfer-sent",
      aggregateType: "inventory_transfer",
      aggregateId: transferId,
      payload: { transferId, fromLocationId: actor.locationId },
      occurredAt: now,
    },
  ]);

  return { id: result.id, version: result.version, status: result.status };
}

/** Sends a DRAFT: TRANSFER_OUT for every line, cost frozen. Idempotent on the client key. */
export async function sendTransfer(
  database: Database,
  actor: Actor,
  transferId: string,
  input: { expectedVersion: number; idempotencyKey: string },
  now = new Date(),
) {
  assertPermission(actor, "inventory.transfer");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: SEND_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { transferId, expectedVersion: input.expectedVersion },
      },
      () => sendIn(transaction, actor, transferId, input.expectedVersion, now),
    ),
  );

  return outcome.response;
}

export type ReceivedLine = { lineId: string; quantityReceived: string };

async function receiveIn(
  transaction: DatabaseTransaction,
  actor: Actor,
  transferId: string,
  input: { expectedVersion: number; lines: readonly ReceivedLine[] | null },
  now: Date,
) {
  const transfer = await lockTransfer(transaction, actor, transferId, input.expectedVersion);

  if (transfer.toLocationId !== actor.locationId) {
    throw new AuthorizationError();
  }

  if (transfer.status !== "SENT") {
    throw new BusinessRuleError("TRANSFER_NOT_SENT", "Only a sent transfer can be received.");
  }

  const lines = await transferLines(transaction, transferId);
  const entered = new Map((input.lines ?? []).map((line) => [line.lineId, line.quantityReceived]));

  if (input.lines && (entered.size !== lines.length || lines.some((line) => !entered.has(line.id)))) {
    throw new ValidationError("Enter what arrived for every line.");
  }

  for (const line of lines) {
    await lockBalance(transaction, actor.organizationId, line.inventoryItemId, actor.locationId);
  }

  const sentRows = new Map(
    (
      await transaction
        .select({ id: inventoryTransactions.id, inventoryItemId: inventoryTransactions.inventoryItemId })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.referenceType, TRANSFER_REFERENCE),
            eq(inventoryTransactions.referenceId, transferId),
            eq(inventoryTransactions.transactionType, "TRANSFER_OUT"),
          ),
        )
    ).map((row) => [row.inventoryItemId, row.id]),
  );
  let shortLines = 0;

  for (const line of lines) {
    const facts = await requireItemFacts(transaction, actor.organizationId, line.inventoryItemId);
    // What arrived, in base units, from the quantity entered in the line's own unit.
    const arrivedEntered = entered.get(line.id) ?? line.quantity;

    if (compareDecimals(arrivedEntered, "0") < 0) {
      throw new BusinessRuleError("INVALID_QUANTITY", "A received quantity can't be negative.");
    }

    const arrived =
      compareDecimals(arrivedEntered, "0") === 0
        ? "0.0000"
        : toBaseQuantity(await loadConversionContext(transaction, facts.id), arrivedEntered, line.unitOfMeasureId, facts.baseUnitId);

    if (compareDecimals(arrived, line.baseQuantity) > 0) {
      throw new BusinessRuleError("OVER_RECEIVED", "More can't arrive than was sent.");
    }

    await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      inventoryItemId: line.inventoryItemId,
      type: "TRANSFER_IN",
      quantity: line.baseQuantity,
      unitOfMeasureId: facts.baseUnitId,
      incomingTotalCost: line.unitCostSent === null ? undefined : extendCost(line.baseQuantity, line.unitCostSent),
      reference: { type: TRANSFER_REFERENCE, id: transferId },
      notes: transfer.transferNumber,
      occurredAt: now,
      createdByUserId: actor.userId,
      // Policy 19: the lots the send took arrive as lots here.
      lot: { mirrorTransactionId: sentRows.get(line.inventoryItemId) ?? null },
    });

    const shortfall = subtractDecimals(line.baseQuantity, arrived);

    if (isPositiveDecimal(shortfall)) {
      shortLines += 1;
      await postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: line.inventoryItemId,
        type: "ADJUST_DECREASE",
        quantity: shortfall,
        unitOfMeasureId: facts.baseUnitId,
        reasonCode: "TRANSFER_SHORTAGE",
        reference: { type: TRANSFER_REFERENCE, id: transferId },
        notes: `${transfer.transferNumber} arrived short`,
        occurredAt: now,
        createdByUserId: actor.userId,
      });
    }

    await transaction
      .update(inventoryTransferLines)
      .set({ baseQuantityReceived: arrived, updatedAt: now })
      .where(eq(inventoryTransferLines.id, line.id));
  }

  const result = await bumpTransfer(transaction, transferId, {
    status: "RECEIVED",
    receivedAt: now,
    receivedByUserId: actor.userId,
  });

  await recordAudit(transaction, actor, {
    action: "inventory.transfer-received",
    entityId: transferId,
    after: { transferNumber: transfer.transferNumber, fromLocationId: transfer.fromLocationId, lineCount: lines.length, shortLines },
  });
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: transfer.fromLocationId,
      eventType: "inventory.transfer-received",
      aggregateType: "inventory_transfer",
      aggregateId: transferId,
      payload: { transferId, toLocationId: actor.locationId },
      occurredAt: now,
    },
  ]);

  return { id: result.id, version: result.version, status: result.status, shortLines };
}

/**
 * Receives a SENT transfer at the actor's location, all lines at once. `lines` gives what
 * arrived per line in its own unit; omitted, everything sent arrived. Idempotent.
 */
export async function receiveTransfer(
  database: Database,
  actor: Actor,
  transferId: string,
  input: { expectedVersion: number; idempotencyKey: string; lines: readonly ReceivedLine[] | null },
  now = new Date(),
) {
  assertPermission(actor, "inventory.transfer");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: RECEIVE_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { transferId, expectedVersion: input.expectedVersion, lines: input.lines },
      },
      () => receiveIn(transaction, actor, transferId, input, now),
    ),
  );

  return outcome.response;
}

/**
 * Policy 13: "Send and receive now", today's one-step move, for someone with
 * `inventory.transfer` at both locations. Creates the record, sends and receives it in
 * full in one transaction.
 */
export async function transferNow(
  database: Database,
  actor: Actor,
  input: { toLocationId: string; notes: string | null; lines: readonly TransferLineInput[] },
  now = new Date(),
) {
  assertPermission(actor, "inventory.transfer");
  await assertTransferAllowedAt(database, actor, input.toLocationId);

  const receiver: Actor = { ...actor, locationId: input.toLocationId };

  return withTransaction(database, async (transaction) => {
    const created = await createTransferIn(transaction, actor, input);
    const sent = await sendIn(transaction, actor, created.id, created.version, now);
    const received = await receiveIn(transaction, receiver, created.id, { expectedVersion: sent.version, lines: null }, now);

    return { id: created.id, transferNumber: created.transferNumber, version: received.version };
  });
}

/** Transfers from or to the actor's location, newest first, with their lines. */
export async function listTransfers(
  database: Database,
  actor: Actor,
  options: { status?: readonly string[] } = {},
) {
  assertPermission(actor, "inventory.view");

  const rows = await database
    .select({
      id: inventoryTransfers.id,
      transferNumber: inventoryTransfers.transferNumber,
      status: inventoryTransfers.status,
      fromLocationId: inventoryTransfers.fromLocationId,
      toLocationId: inventoryTransfers.toLocationId,
      notes: inventoryTransfers.notes,
      sentAt: inventoryTransfers.sentAt,
      receivedAt: inventoryTransfers.receivedAt,
      createdAt: inventoryTransfers.createdAt,
      version: inventoryTransfers.version,
    })
    .from(inventoryTransfers)
    .where(
      and(
        eq(inventoryTransfers.organizationId, actor.organizationId),
        or(eq(inventoryTransfers.fromLocationId, actor.locationId), eq(inventoryTransfers.toLocationId, actor.locationId)),
        options.status ? inArray(inventoryTransfers.status, [...options.status]) : undefined,
      ),
    )
    .orderBy(desc(inventoryTransfers.createdAt))
    .limit(100);
  const ids = rows.map((row) => row.id);
  const lines =
    ids.length === 0
      ? []
      : await database
          .select({
            id: inventoryTransferLines.id,
            transferId: inventoryTransferLines.transferId,
            inventoryItemId: inventoryTransferLines.inventoryItemId,
            itemName: inventoryItems.name,
            quantity: inventoryTransferLines.quantity,
            unitOfMeasureId: inventoryTransferLines.unitOfMeasureId,
            unitCode: unitsOfMeasure.code,
            baseQuantity: inventoryTransferLines.baseQuantity,
            baseQuantityReceived: inventoryTransferLines.baseQuantityReceived,
            unitCostSent: inventoryTransferLines.unitCostSent,
          })
          .from(inventoryTransferLines)
          .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryTransferLines.inventoryItemId))
          .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryTransferLines.unitOfMeasureId))
          .where(inArray(inventoryTransferLines.transferId, ids))
          .orderBy(asc(inventoryItems.name));
  const showCost = canSeeCost(actor);

  return rows.map((row) => ({
    ...row,
    direction: row.fromLocationId === actor.locationId ? ("OUTGOING" as const) : ("INCOMING" as const),
    lines: lines
      .filter((line) => line.transferId === row.id)
      .map(({ unitCostSent, ...line }) => ({
        ...line,
        valueSent: showCost && unitCostSent !== null ? extendCost(line.baseQuantity, unitCostSent) : null,
      })),
  }));
}
