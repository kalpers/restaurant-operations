import { and, asc, eq, inArray } from "drizzle-orm";

import { inventoryItems, inventoryTransactions } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { addDecimals, compareDecimals, negateDecimal, subtractDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { lockBalance, postInventoryTransaction, readPostingSettings, type PostingResult } from "./posting-service";

// The two narrow, trusted capabilities the Order workflows use inside their own
// transaction. They are not exposed through any Inventory endpoint and accept no
// transaction type: one only CONSUMEs for submitted Order Items, the other only reverses
// such a CONSUME. The caller authorizes (`orders.submit`, `orders.void`); no Inventory
// permission is needed or granted. Conversion, negative-stock policy, costing, balance and
// ledger all stay in `postInventoryTransaction`.

export const ORDER_ITEM_REFERENCE = "ORDER_ITEM";
export const ORDER_ITEM_VOID_REFERENCE = "ORDER_ITEM_VOID";

export type OrderConsumptionLine = {
  orderItemId: string;
  inventoryItemId: string;
  /** Positive, in the Inventory Item's base unit. */
  baseQuantity: string;
};

export type StockShortage = {
  inventoryItemId: string;
  inventoryItemName: string;
  baseUnitId: string;
  required: string;
  available: string;
  shortage: string;
};

export class InsufficientStockError extends BusinessRuleError {
  constructor(readonly shortages: StockShortage[]) {
    super(
      "INSUFFICIENT_STOCK",
      "There isn't enough stock on hand to send these items.",
      { shortages },
    );
  }
}

/**
 * Posts one CONSUME per line, all or nothing. Balances are locked in Inventory Item order
 * and, when the Location doesn't allow negative stock, every shortage across the batch is
 * collected (quantities only, never cost) before anything is posted.
 */
export async function postOrderConsumption(
  transaction: DatabaseTransaction,
  input: {
    organizationId: string;
    locationId: string;
    occurredAt: Date;
    createdByUserId: string;
    lines: readonly OrderConsumptionLine[];
  },
): Promise<(OrderConsumptionLine & { posting: PostingResult; baseUnitId: string })[]> {
  if (input.lines.length === 0) {
    return [];
  }

  const settings = await readPostingSettings(transaction, input.organizationId, input.locationId);
  const totals = new Map<string, string>();

  for (const line of input.lines) {
    totals.set(line.inventoryItemId, addDecimals(totals.get(line.inventoryItemId) ?? "0", line.baseQuantity));
  }

  const itemIds = [...totals.keys()].sort();
  const items = await transaction
    .select({ id: inventoryItems.id, name: inventoryItems.name, baseUnitId: inventoryItems.baseUnitId })
    .from(inventoryItems)
    .where(
      and(inArray(inventoryItems.id, itemIds), eq(inventoryItems.organizationId, input.organizationId)),
    );
  const itemById = new Map(items.map((item) => [item.id, item]));
  const shortages: StockShortage[] = [];

  for (const itemId of itemIds) {
    const item = itemById.get(itemId);

    if (!item) {
      throw new NotFoundError("inventory item");
    }

    const balance = await lockBalance(transaction, input.organizationId, itemId, input.locationId);
    const required = totals.get(itemId)!;
    const after = subtractDecimals(balance.quantityOnHand, required);

    if (!settings.allowNegative && compareDecimals(after, "0") < 0) {
      shortages.push({
        inventoryItemId: itemId,
        inventoryItemName: item.name,
        baseUnitId: item.baseUnitId,
        required,
        available: balance.quantityOnHand,
        shortage: negateDecimal(after),
      });
    }
  }

  if (shortages.length > 0) {
    throw new InsufficientStockError(shortages);
  }

  const ordered = [...input.lines].sort(
    (a, b) =>
      a.inventoryItemId.localeCompare(b.inventoryItemId) || a.orderItemId.localeCompare(b.orderItemId),
  );
  const results = [];

  for (const line of ordered) {
    const item = itemById.get(line.inventoryItemId)!;
    const posting = await postInventoryTransaction(transaction, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      inventoryItemId: line.inventoryItemId,
      type: "CONSUME",
      quantity: line.baseQuantity,
      unitOfMeasureId: item.baseUnitId,
      occurredAt: input.occurredAt,
      reference: { type: ORDER_ITEM_REFERENCE, id: line.orderItemId },
      createdByUserId: input.createdByUserId,
    });

    results.push({ ...line, posting, baseUnitId: item.baseUnitId });
  }

  return results;
}

/**
 * Restores stock consumed by an Order Item that was never prepared: a SALE_REVERSAL linked
 * to the original CONSUME, entering at that row's cost through weighted-average costing
 * (with no cost if the original had none). The original row is never changed, and the
 * ledger allows only one reversal per CONSUME.
 */
export async function postSaleReversal(
  transaction: DatabaseTransaction,
  input: {
    organizationId: string;
    locationId: string;
    originalTransactionIds: readonly string[];
    voidId: string;
    occurredAt: Date;
    createdByUserId: string;
  },
): Promise<PostingResult[]> {
  if (input.originalTransactionIds.length === 0) {
    return [];
  }

  const originals = await transaction
    .select()
    .from(inventoryTransactions)
    .where(inArray(inventoryTransactions.id, [...input.originalTransactionIds]))
    .orderBy(asc(inventoryTransactions.inventoryItemId));

  if (originals.length !== input.originalTransactionIds.length) {
    throw new NotFoundError("inventory transaction");
  }

  const results: PostingResult[] = [];

  for (const original of originals) {
    if (
      original.transactionType !== "CONSUME" ||
      original.referenceType !== ORDER_ITEM_REFERENCE ||
      original.organizationId !== input.organizationId ||
      original.locationId !== input.locationId
    ) {
      throw new BusinessRuleError(
        "NOT_ORDER_CONSUMPTION",
        "Only an order item's own consumption can be reversed.",
      );
    }

    results.push(
      await postInventoryTransaction(transaction, {
        organizationId: input.organizationId,
        locationId: input.locationId,
        inventoryItemId: original.inventoryItemId,
        type: "SALE_REVERSAL",
        quantity: negateDecimal(original.baseQuantityDelta),
        unitOfMeasureId: await baseUnitOf(transaction, original.inventoryItemId),
        incomingTotalCost: original.totalCost ?? undefined,
        occurredAt: input.occurredAt,
        reference: { type: ORDER_ITEM_VOID_REFERENCE, id: input.voidId },
        reversesTransactionId: original.id,
        createdByUserId: input.createdByUserId,
      }),
    );
  }

  return results;
}

async function baseUnitOf(transaction: DatabaseTransaction, inventoryItemId: string) {
  const [item] = await transaction
    .select({ baseUnitId: inventoryItems.baseUnitId })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId));

  return item!.baseUnitId;
}
