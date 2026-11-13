import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { inventoryTransactions } from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";

import type { AdjustmentReason, WasteReason } from "../types";
import { assertPermission } from "./access";
import { postInventoryTransaction, type PostingResult } from "./posting-service";
import { TRANSFER_REFERENCE, transferNow } from "./transfer-service";

type MovementInput = {
  inventoryItemId: string;
  /** Phase 23 (D9): a decrease from this lot instead of first to expire. */
  lotId?: string | null;
  /** Phase 23: the use-by date of stock found by an increase. */
  expiresOn?: string | null;
  quantity: string;
  unitOfMeasureId: string;
  notes: string | null;
  occurredAt?: Date;
};

/** Records waste at the actor's location: a negative WASTE row with a reason code. */
export async function recordWaste(
  database: Database,
  actor: Actor,
  input: MovementInput & { reasonCode: WasteReason },
): Promise<PostingResult> {
  assertPermission(actor, "inventory.waste");

  return withTransaction(database, async (transaction) => {
    const posted = await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      inventoryItemId: input.inventoryItemId,
      type: "WASTE",
      quantity: input.quantity,
      unitOfMeasureId: input.unitOfMeasureId,
      reasonCode: input.reasonCode,
      notes: input.notes,
      occurredAt: input.occurredAt,
      createdByUserId: actor.userId,
      lot: { lotId: input.lotId ?? null },
    });

    await auditMovement(transaction, actor, "inventory.waste-recorded", input, posted);

    return posted;
  });
}

/** A manual correction. There is no "set quantity": only an increase or a decrease. */
export async function recordAdjustment(
  database: Database,
  actor: Actor,
  input: MovementInput & { direction: "INCREASE" | "DECREASE"; reasonCode: AdjustmentReason },
): Promise<PostingResult> {
  assertPermission(actor, "inventory.adjust");

  return withTransaction(database, async (transaction) => {
    const posted = await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      inventoryItemId: input.inventoryItemId,
      type: input.direction === "INCREASE" ? "ADJUST_INCREASE" : "ADJUST_DECREASE",
      quantity: input.quantity,
      unitOfMeasureId: input.unitOfMeasureId,
      reasonCode: input.reasonCode,
      notes: input.notes,
      occurredAt: input.occurredAt,
      createdByUserId: actor.userId,
      lot:
        input.direction === "INCREASE"
          ? { expiresOn: input.expiresOn ?? null }
          : { lotId: input.lotId ?? null },
    });

    await auditMovement(transaction, actor, "inventory.adjusted", input, posted);

    return posted;
  });
}

/**
 * Moves stock from the actor's location to another in the same organization: a TRANSFER_OUT
 * and a TRANSFER_IN with one shared reference, in one transaction. The actor needs
 * `inventory.transfer` at both locations (checked against the database for the destination).
 * The source's average cost travels with the stock. Total quantity is unchanged.
 *
 * Phase 23 (policy 13): this is "Send and receive now". It creates a one-line transfer
 * record, sends and receives it in full, and the reference is the transfer's ID.
 */
export async function transferStock(
  database: Database,
  actor: Actor,
  input: MovementInput & { toLocationId: string },
): Promise<{ transferId: string; out: PostingResult; in: PostingResult }> {
  assertPermission(actor, "inventory.transfer");

  const created = await transferNow(
    database,
    actor,
    {
      toLocationId: input.toLocationId,
      notes: input.notes,
      lines: [{ inventoryItemId: input.inventoryItemId, quantity: input.quantity, unitOfMeasureId: input.unitOfMeasureId }],
    },
    input.occurredAt,
  );
  const rows = await database
    .select()
    .from(inventoryTransactions)
    .where(
      and(
        eq(inventoryTransactions.referenceType, TRANSFER_REFERENCE),
        eq(inventoryTransactions.referenceId, created.id),
      ),
    );
  const result = (type: string): PostingResult => {
    const row = rows.find((candidate) => candidate.transactionType === type)!;

    return {
      transactionId: row.id,
      sequence: row.sequence,
      baseQuantityDelta: row.baseQuantityDelta,
      quantityAfter: row.quantityAfter,
      averageCostAfter: row.averageCostAfter,
      unitCost: row.unitCost,
      totalCost: row.totalCost,
    };
  };

  return { transferId: created.id, out: result("TRANSFER_OUT"), in: result("TRANSFER_IN") };
}

/** The free-text notes are not recorded; the ledger row keeps them. */
function auditMovement(
  transaction: DatabaseTransaction,
  actor: Actor,
  action: "inventory.adjusted" | "inventory.waste-recorded",
  input: { inventoryItemId: string; reasonCode: string },
  posted: PostingResult,
): Promise<void> {
  return recordAudit(transaction, actor, {
    action,
    entityId: input.inventoryItemId,
    after: { transactionId: posted.transactionId, quantity: posted.baseQuantityDelta, reasonCode: input.reasonCode },
  });
}

/**
 * Posts consumption inside a caller's transaction. Phase 9 order SEND is its first caller;
 * the caller authorizes, and passes its own reference so a retry can be detected there.
 * Whether stock may go negative is the location's `allow_negative_inventory` setting.
 */
export function postConsumption(
  transaction: DatabaseTransaction,
  input: {
    organizationId: string;
    locationId: string;
    inventoryItemId: string;
    quantity: string;
    unitOfMeasureId: string;
    reference: { type: string; id: string };
    createdByUserId: string | null;
    occurredAt?: Date;
  },
): Promise<PostingResult> {
  return postInventoryTransaction(transaction, { ...input, type: "CONSUME" });
}
