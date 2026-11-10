import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItems,
  locations,
  locationSettings,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrderReceipts,
  supplierItemCostHistory,
  supplierItems,
} from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  addDecimals,
  compareDecimals,
  multiplyExact,
  toScale,
} from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";

import { extendCost } from "../rules/costing";
import { assertReceivable, canReceive, statusAfterReceipt } from "../rules/purchasing";
import { assertPermission } from "./access";
import { postInventoryTransaction } from "./posting-service";
import { bumpOrder, lockOrder, receivedByLine } from "./purchase-order-service";

export type ReceiptLineInput = {
  purchaseOrderLineId: string;
  /** In the line's purchase unit. */
  receivedQuantity: string;
  /** Actual price per purchase unit; defaults to the ordered price. */
  actualUnitCost: string | null;
};

/**
 * Receives goods against a submitted order, in one transaction: the receipt and its lines,
 * a RECEIVE ledger row per line through the posting service (which updates the balance and
 * weighted-average cost), the supplier cost history, and the order status. Over-receiving
 * is refused, with no override. The ordered price is never rewritten.
 */
export async function receivePurchaseOrder(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  input: {
    lines: readonly ReceiptLineInput[];
    supplierReference: string | null;
    notes: string | null;
    receivedAt?: Date;
  },
) {
  assertPermission(actor, "inventory.receive");

  if (input.lines.length === 0) {
    throw new BusinessRuleError("NOTHING_RECEIVED", "Enter at least one received quantity.");
  }

  const ids = input.lines.map((line) => line.purchaseOrderLineId);

  if (new Set(ids).size !== ids.length) {
    throw new BusinessRuleError("DUPLICATE_LINE", "Each order line can appear once per receipt.");
  }

  const receivedAt = input.receivedAt ?? new Date();

  return withTransaction(database, async (transaction) => {
    // The order lock serializes receipts against one order, so remaining quantities hold.
    const order = await lockOrder(transaction, actor, purchaseOrderId, null);

    if (!canReceive(order.status)) {
      throw new BusinessRuleError(
        "PO_NOT_RECEIVABLE",
        order.status === "DRAFT"
          ? "Submit the purchase order before receiving against it."
          : "This purchase order can't receive any more goods.",
      );
    }

    const lines = await transaction
      .select({ line: purchaseOrderLines, baseUnitId: inventoryItems.baseUnitId })
      .from(purchaseOrderLines)
      .innerJoin(inventoryItems, eq(inventoryItems.id, purchaseOrderLines.inventoryItemId))
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
    const byId = new Map(lines.map((entry) => [entry.line.id, entry]));
    const received = await receivedByLine(transaction, purchaseOrderId);
    const [clock] = await transaction
      .select({ timeZone: locations.timezone, businessDayCutoff: locationSettings.businessDayCutoff })
      .from(locations)
      .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
      .where(eq(locations.id, actor.locationId));
    const [receipt] = await transaction
      .insert(purchaseOrderReceipts)
      .values({
        purchaseOrderId,
        locationId: actor.locationId,
        receivedAt,
        businessDate: businessDateOf(receivedAt, clock!),
        receivedByUserId: actor.userId,
        supplierReference: input.supplierReference,
        notes: input.notes,
      })
      .returning();
    const postedLines = [];

    for (const entry of input.lines) {
      const found = byId.get(entry.purchaseOrderLineId);

      if (!found) {
        throw new NotFoundError("purchase order line");
      }

      const { line, baseUnitId } = found;
      let receivedQuantity: string;

      try {
        receivedQuantity = toScale(entry.receivedQuantity, 4);
      } catch {
        throw new BusinessRuleError(
          "INVALID_QUANTITY",
          "Received quantities have at most four decimal places.",
        );
      }

      assertReceivable({
        ordered: line.orderedQuantity,
        receivedSoFar: received.get(line.id) ?? "0",
        receiving: receivedQuantity,
      });

      let actualUnitCost: string;

      try {
        actualUnitCost = toScale(entry.actualUnitCost ?? line.unitPrice, 4);
      } catch {
        throw new BusinessRuleError("INVALID_COST", "A cost has at most four decimal places.");
      }

      if (compareDecimals(actualUnitCost, "0") < 0) {
        throw new BusinessRuleError("INVALID_COST", "A cost can't be negative.");
      }

      // The conversion snapshotted on the line, so a later supplier-item edit can't change it.
      let baseQuantity: string;

      try {
        baseQuantity = toScale(multiplyExact(receivedQuantity, line.baseUnitsPerPurchase), 4);
      } catch {
        throw new BusinessRuleError(
          "CONVERSION_PRECISION",
          "That quantity converts to more than four decimal places of stock.",
        );
      }

      const totalCost = extendCost(receivedQuantity, actualUnitCost);
      const posting = await postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: line.inventoryItemId,
        type: "RECEIVE",
        quantity: baseQuantity,
        unitOfMeasureId: baseUnitId,
        incomingTotalCost: totalCost,
        occurredAt: receivedAt,
        reference: { type: "PURCHASE_ORDER_RECEIPT", id: receipt!.id },
        createdByUserId: actor.userId,
      });
      const [receiptLine] = await transaction
        .insert(purchaseOrderReceiptLines)
        .values({
          receiptId: receipt!.id,
          purchaseOrderLineId: line.id,
          receivedQuantity,
          purchaseUnitId: line.purchaseUnitId,
          actualUnitCost,
          baseQuantity,
          baseUnitCost: posting.unitCost!,
          totalCost,
          inventoryTransactionId: posting.transactionId,
        })
        .returning();

      await transaction.insert(supplierItemCostHistory).values({
        supplierItemId: line.supplierItemId,
        unitCost: actualUnitCost,
        source: "RECEIPT",
        receiptLineId: receiptLine!.id,
        recordedByUserId: actor.userId,
        recordedAt: receivedAt,
      });
      await transaction
        .update(supplierItems)
        .set({
          lastUnitCost: actualUnitCost,
          version: nextVersion(supplierItems.version),
          updatedAt: new Date(),
        })
        .where(eq(supplierItems.id, line.supplierItemId));

      received.set(line.id, addDecimals(received.get(line.id) ?? "0", receivedQuantity));
      postedLines.push({ ...receiptLine!, quantityOnHandAfter: posting.quantityAfter });
    }

    const status = statusAfterReceipt(
      lines.map(({ line }) => ({
        ordered: line.orderedQuantity,
        received: received.get(line.id) ?? "0",
      })),
    );
    const updated = await bumpOrder(transaction, purchaseOrderId, { status });

    await recordAudit(transaction, actor, {
      action: "inventory.po-received",
      entityId: purchaseOrderId,
      occurredAt: receivedAt,
      before: { status: order.status },
      after: { receiptId: receipt!.id, poNumber: order.poNumber, status: updated.status, lineCount: postedLines.length },
    });

    return { receipt: receipt!, lines: postedLines, status: updated.status, version: updated.version };
  });
}

