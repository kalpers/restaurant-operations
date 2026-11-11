import { and, eq, sql } from "drizzle-orm";

import {
  inventoryBalances,
  inventoryItemLocations,
  inventoryTransactions,
  locations,
  locationSettings,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { compareDecimals, isPositiveDecimal, negateDecimal } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";

import { loadConversionContext, requireItemFacts } from "../repositories/conversion-repository";
import { baseUnitCost, extendCost, nextAverageCost } from "../rules/costing";
import { assertDirection, assertStockPolicy } from "../rules/stock-policy";
import { toBaseQuantity } from "../rules/unit-resolution";
import { TRANSACTION_DIRECTION, type InventoryTransactionType } from "../types";
import { applyStockAlert } from "./stock-alerts";

// The one authoritative stock posting. Receiving, waste, adjustments, transfers, count
// approval and (from Phase 9) order consumption all call this inside their own transaction.
// Nothing else writes `inventory_transactions` or `inventory_balances`.

export type PostingInput = {
  organizationId: string;
  locationId: string;
  inventoryItemId: string;
  type: InventoryTransactionType;
  /** A positive magnitude as entered; the type gives the direction. */
  quantity: string;
  unitOfMeasureId: string;
  /** Incoming movements with their own cost (RECEIVE, TRANSFER_IN): exact total cost. */
  incomingTotalCost?: string;
  occurredAt?: Date;
  reference?: { type: string; id: string };
  /** SALE_REVERSAL only, set by the trusted order-void reversal. */
  reversesTransactionId?: string;
  reasonCode?: string | null;
  notes?: string | null;
  createdByUserId: string | null;
};

export type PostingResult = {
  transactionId: string;
  sequence: number;
  baseQuantityDelta: string;
  quantityAfter: string;
  averageCostAfter: string | null;
  unitCost: string | null;
  totalCost: string | null;
};

/**
 * Locks the balance row for an item at a location, creating it at zero if needed. Every
 * posting holds this lock until commit, so postings for one item and location serialize
 * and no update is lost. Callers that lock several rows must do so in a stable order.
 */
export async function lockBalance(
  transaction: DatabaseTransaction,
  organizationId: string,
  inventoryItemId: string,
  locationId: string,
) {
  await transaction
    .insert(inventoryBalances)
    .values({ organizationId, inventoryItemId, locationId })
    .onConflictDoNothing({
      target: [inventoryBalances.inventoryItemId, inventoryBalances.locationId],
    });

  const [balance] = await transaction
    .select()
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.inventoryItemId, inventoryItemId),
        eq(inventoryBalances.locationId, locationId),
      ),
    )
    .for("update");

  return balance!;
}

/** The latest ledger sequence for an item at a location, read under the balance lock. */
export async function latestSequence(
  transaction: DatabaseTransaction,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const [row] = await transaction
    .select({ value: sql<string | null>`max(${inventoryTransactions.sequence})` })
    .from(inventoryTransactions)
    .where(
      and(
        eq(inventoryTransactions.inventoryItemId, inventoryItemId),
        eq(inventoryTransactions.locationId, locationId),
      ),
    );

  return row?.value === null || row?.value === undefined ? 0 : Number(row.value);
}

export async function readPostingSettings(transaction: DatabaseTransaction, organizationId: string, locationId: string) {
  const [row] = await transaction
    .select({
      timeZone: locations.timezone,
      active: locations.active,
      businessDayCutoff: locationSettings.businessDayCutoff,
      allowNegative: locationSettings.allowNegativeInventory,
      inventoryEnabled: locationSettings.inventoryEnabled,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));

  if (!row) {
    throw new NotFoundError("location");
  }

  if (!row.active || !row.inventoryEnabled) {
    throw new BusinessRuleError(
      "INVENTORY_UNAVAILABLE",
      "Inventory isn't enabled at this location.",
    );
  }

  return row;
}

export async function postInventoryTransaction(
  transaction: DatabaseTransaction,
  input: PostingInput,
): Promise<PostingResult> {
  if (!isPositiveDecimal(input.quantity)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "Enter a quantity greater than zero.");
  }

  const occurredAt = input.occurredAt ?? new Date();
  const settings = await readPostingSettings(transaction, input.organizationId, input.locationId);
  const item = await requireItemFacts(transaction, input.organizationId, input.inventoryItemId);

  if (!item.active) {
    throw new BusinessRuleError("ITEM_INACTIVE", "That inventory item is inactive.");
  }

  const [configured] = await transaction
    .select({ active: inventoryItemLocations.active })
    .from(inventoryItemLocations)
    .where(
      and(
        eq(inventoryItemLocations.inventoryItemId, item.id),
        eq(inventoryItemLocations.locationId, input.locationId),
      ),
    );

  if (!configured?.active) {
    throw new BusinessRuleError(
      "ITEM_NOT_STOCKED_HERE",
      "That item isn't stocked at this location.",
    );
  }

  const direction = TRANSACTION_DIRECTION[input.type];
  const context = await loadConversionContext(transaction, item.id);
  const baseMagnitude = toBaseQuantity(context, input.quantity, input.unitOfMeasureId, item.baseUnitId);

  if (!isPositiveDecimal(baseMagnitude)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "That quantity is too small to record.");
  }

  const baseQuantityDelta = direction === 1 ? baseMagnitude : negateDecimal(baseMagnitude);
  const enteredQuantity = direction === 1 ? input.quantity : negateDecimal(input.quantity);

  assertDirection(input.type, baseQuantityDelta);

  const balance = await lockBalance(transaction, input.organizationId, item.id, input.locationId);
  const quantityAfter = assertStockPolicy({
    type: input.type,
    quantityBefore: balance.quantityOnHand,
    baseQuantityDelta,
    allowNegative: settings.allowNegative,
  });

  let averageCostAfter = balance.weightedAverageCost;
  let unitCost: string | null;
  let totalCost: string | null;

  if (input.incomingTotalCost !== undefined) {
    if (direction !== 1) {
      throw new BusinessRuleError("INVALID_COST", "Only incoming stock carries its own cost.");
    }

    if (compareDecimals(input.incomingTotalCost, "0") < 0) {
      throw new BusinessRuleError("INVALID_COST", "A cost can't be negative.");
    }

    totalCost = input.incomingTotalCost;
    unitCost = baseUnitCost(totalCost, baseMagnitude);
    averageCostAfter = nextAverageCost({
      quantityBefore: balance.quantityOnHand,
      averageBefore: balance.weightedAverageCost,
      quantityIn: baseMagnitude,
      totalCostIn: totalCost,
    });
  } else {
    // Movements without their own cost are valued at the current average, which they
    // don't change.
    unitCost = balance.weightedAverageCost;
    totalCost = unitCost === null ? null : extendCost(baseMagnitude, unitCost);
  }

  const [posted] = await transaction
    .insert(inventoryTransactions)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      inventoryItemId: item.id,
      transactionType: input.type,
      quantity: enteredQuantity,
      unitOfMeasureId: input.unitOfMeasureId,
      baseQuantityDelta,
      unitCost,
      totalCost,
      quantityAfter,
      averageCostAfter,
      businessDate: businessDateOf(occurredAt, settings),
      occurredAt,
      referenceType: input.reference?.type ?? null,
      referenceId: input.reference?.id ?? null,
      reversesTransactionId: input.reversesTransactionId ?? null,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: inventoryTransactions.id, sequence: inventoryTransactions.sequence });

  await transaction
    .update(inventoryBalances)
    .set({
      quantityOnHand: quantityAfter,
      weightedAverageCost: averageCostAfter,
      version: sql`${inventoryBalances.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryBalances.id, balance.id));

  // Phase 19: open or resolve the item's low-stock alert, still under the balance lock.
  await applyStockAlert(transaction, {
    organizationId: input.organizationId,
    locationId: input.locationId,
    inventoryItemId: item.id,
    quantityBefore: balance.quantityOnHand,
    quantityAfter,
    transactionId: posted!.id,
    occurredAt,
  });

  return {
    transactionId: posted!.id,
    sequence: posted!.sequence,
    baseQuantityDelta,
    quantityAfter,
    averageCostAfter,
    unitCost,
    totalCost,
  };
}
