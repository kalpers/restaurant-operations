import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import { userHasPermission } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { negateDecimal } from "@/shared/decimal/decimal";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";

import { extendCost } from "../rules/costing";
import type { AdjustmentReason, WasteReason } from "../types";
import { assertPermission } from "./access";
import { lockBalance, postInventoryTransaction, type PostingResult } from "./posting-service";

type MovementInput = {
  inventoryItemId: string;
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
 */
export async function transferStock(
  database: Database,
  actor: Actor,
  input: MovementInput & { toLocationId: string },
): Promise<{ transferId: string; out: PostingResult; in: PostingResult }> {
  assertPermission(actor, "inventory.transfer");

  if (input.toLocationId === actor.locationId) {
    throw new BusinessRuleError("SAME_LOCATION", "Choose a different location to transfer to.");
  }

  const allowedThere = await userHasPermission(database, {
    userId: actor.userId,
    permission: "inventory.transfer",
    locationId: input.toLocationId,
  });

  if (!allowedThere) {
    throw new AuthorizationError();
  }

  const transferId = randomUUID();

  return withTransaction(database, async (transaction) => {
    // Lock both balances in a stable order so opposite transfers can't deadlock.
    for (const locationId of [actor.locationId, input.toLocationId].sort()) {
      await lockBalance(transaction, actor.organizationId, input.inventoryItemId, locationId);
    }

    const reference = { type: "TRANSFER", id: transferId };
    const out = await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      inventoryItemId: input.inventoryItemId,
      type: "TRANSFER_OUT",
      quantity: input.quantity,
      unitOfMeasureId: input.unitOfMeasureId,
      reference,
      notes: input.notes,
      occurredAt: input.occurredAt,
      createdByUserId: actor.userId,
    });
    const movedCost =
      out.unitCost === null ? undefined : extendCost(negateDecimal(out.baseQuantityDelta), out.unitCost);
    const arrived = await postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: input.toLocationId,
      inventoryItemId: input.inventoryItemId,
      type: "TRANSFER_IN",
      quantity: input.quantity,
      unitOfMeasureId: input.unitOfMeasureId,
      incomingTotalCost: movedCost,
      reference,
      notes: input.notes,
      occurredAt: input.occurredAt,
      createdByUserId: actor.userId,
    });

    await recordAudit(transaction, actor, {
      action: "inventory.transferred",
      entityId: input.inventoryItemId,
      after: { transferId, quantity: out.baseQuantityDelta, destinationLocationId: input.toLocationId },
    });

    return { transferId, out, in: arrived };
  });
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
