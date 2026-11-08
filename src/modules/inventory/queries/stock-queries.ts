import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import {
  inventoryBalances,
  inventoryItemLocations,
  inventoryItems,
  inventoryTransactions,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";

import { extendCost } from "../rules/costing";
import { evaluateStock } from "../rules/replenishment";
import { assertPermission, canSeeCost } from "../services/access";
import type { InventoryTransactionType } from "../types";

// Read models. QOH comes from the balance projection, which every posting maintains in the
// same transaction as its ledger row; `ledgerQuantityOnHand` recomputes it from the ledger,
// and `reconcileBalances` proves the two agree. Cost fields are null unless the actor holds
// `inventory.cost.view`.

/** Every item stocked at the actor's location, with on-hand, levels and replenishment hints. */
export async function listOnHand(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "inventory.view");

  const rows = await executor
    .select({
      inventoryItemId: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      itemActive: inventoryItems.active,
      baseUnitId: inventoryItems.baseUnitId,
      baseUnitCode: unitsOfMeasure.code,
      stockedActive: inventoryItemLocations.active,
      parLevel: inventoryItemLocations.parLevel,
      reorderLevel: inventoryItemLocations.reorderLevel,
      reorderTarget: inventoryItemLocations.reorderTarget,
      configurationId: inventoryItemLocations.id,
      configurationVersion: inventoryItemLocations.version,
      quantityOnHand: inventoryBalances.quantityOnHand,
      weightedAverageCost: inventoryBalances.weightedAverageCost,
    })
    .from(inventoryItemLocations)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryItemLocations.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryItems.baseUnitId))
    .leftJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.inventoryItemId, inventoryItemLocations.inventoryItemId),
        eq(inventoryBalances.locationId, inventoryItemLocations.locationId),
      ),
    )
    .where(
      and(
        eq(inventoryItemLocations.locationId, actor.locationId),
        eq(inventoryItems.organizationId, actor.organizationId),
      ),
    )
    .orderBy(asc(inventoryItems.name));
  const showCost = canSeeCost(actor);

  return rows.map((row) => {
    const quantityOnHand = toScale(row.quantityOnHand ?? "0", 4);
    const evaluation = evaluateStock(quantityOnHand, row);

    return {
      ...row,
      quantityOnHand,
      ...evaluation,
      weightedAverageCost: showCost ? row.weightedAverageCost : null,
      stockValue:
        showCost && row.weightedAverageCost !== null && !quantityOnHand.startsWith("-")
          ? extendCost(quantityOnHand, row.weightedAverageCost)
          : null,
    };
  });
}

/** Items at or below their reorder level, with every active supplier option. No selection. */
export async function listLowStock(executor: DatabaseExecutor, actor: Actor) {
  const low = (await listOnHand(executor, actor)).filter(
    (row) => row.low && row.itemActive && row.stockedActive,
  );

  if (low.length === 0) {
    return [];
  }

  const options = await executor
    .select({
      supplierItemId: supplierItems.id,
      inventoryItemId: supplierItems.inventoryItemId,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      purchaseUnitCode: unitsOfMeasure.code,
      baseUnitsPerPurchase: supplierItems.baseUnitsPerPurchase,
      lastUnitCost: supplierItems.lastUnitCost,
    })
    .from(supplierItems)
    .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, supplierItems.purchaseUnitId))
    .where(
      and(
        eq(supplierItems.organizationId, actor.organizationId),
        eq(supplierItems.active, true),
        eq(suppliers.active, true),
      ),
    )
    .orderBy(asc(suppliers.name), asc(supplierItems.id));
  const showCost = canSeeCost(actor);

  return low.map((row) => ({
    ...row,
    supplierOptions: options
      .filter((option) => option.inventoryItemId === row.inventoryItemId)
      .map((option) => ({ ...option, lastUnitCost: showCost ? option.lastUnitCost : null })),
  }));
}

/**
 * QOH recomputed from the ledger alone: the sum of base-unit deltas, optionally as of an
 * instant (by occurrence) or a business date (inclusive).
 */
export async function ledgerQuantityOnHand(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    inventoryItemId: string;
    locationId: string;
    asOf?: Date;
    throughBusinessDate?: string;
  },
): Promise<string> {
  const [row] = await executor
    .select({
      total: sql<string>`coalesce(sum(${inventoryTransactions.baseQuantityDelta}), 0)::text`,
    })
    .from(inventoryTransactions)
    .where(
      and(
        eq(inventoryTransactions.organizationId, input.organizationId),
        eq(inventoryTransactions.inventoryItemId, input.inventoryItemId),
        eq(inventoryTransactions.locationId, input.locationId),
        input.asOf ? lte(inventoryTransactions.occurredAt, input.asOf) : undefined,
        input.throughBusinessDate
          ? lte(inventoryTransactions.businessDate, input.throughBusinessDate)
          : undefined,
      ),
    );

  return toScale(row?.total ?? "0", 4);
}

/** Balances whose quantity disagrees with the ledger. Empty means the projection is sound. */
export async function reconcileBalances(executor: DatabaseExecutor, organizationId: string) {
  const rows = await executor.execute<{
    inventory_item_id: string;
    location_id: string;
    balance: string;
    ledger: string;
  }>(sql`
    SELECT b.inventory_item_id, b.location_id, b.quantity_on_hand::text AS balance,
           coalesce(l.total, 0)::text AS ledger
    FROM ${inventoryBalances} b
    LEFT JOIN (
      SELECT inventory_item_id, location_id, sum(base_quantity_delta) AS total
      FROM ${inventoryTransactions}
      WHERE organization_id = ${organizationId}
      GROUP BY inventory_item_id, location_id
    ) l ON l.inventory_item_id = b.inventory_item_id AND l.location_id = b.location_id
    WHERE b.organization_id = ${organizationId}
      AND b.quantity_on_hand <> coalesce(l.total, 0)
  `);

  return [...rows].map((row) => ({
    inventoryItemId: row.inventory_item_id,
    locationId: row.location_id,
    balance: row.balance,
    ledger: row.ledger,
  }));
}

export type TransactionFilter = {
  inventoryItemId?: string;
  transactionType?: InventoryTransactionType;
  fromBusinessDate?: string;
  toBusinessDate?: string;
  referenceId?: string;
  limit?: number;
};

/** The read-only ledger at the actor's location, newest first. */
export async function listTransactions(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: TransactionFilter = {},
) {
  assertPermission(actor, "inventory.view");

  const rows = await executor
    .select({
      transaction: inventoryTransactions,
      itemName: inventoryItems.name,
      unitCode: unitsOfMeasure.code,
    })
    .from(inventoryTransactions)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryTransactions.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryTransactions.unitOfMeasureId))
    .where(
      and(
        eq(inventoryTransactions.organizationId, actor.organizationId),
        eq(inventoryTransactions.locationId, actor.locationId),
        filter.inventoryItemId ? eq(inventoryTransactions.inventoryItemId, filter.inventoryItemId) : undefined,
        filter.transactionType ? eq(inventoryTransactions.transactionType, filter.transactionType) : undefined,
        filter.fromBusinessDate ? gte(inventoryTransactions.businessDate, filter.fromBusinessDate) : undefined,
        filter.toBusinessDate ? lte(inventoryTransactions.businessDate, filter.toBusinessDate) : undefined,
        filter.referenceId ? eq(inventoryTransactions.referenceId, filter.referenceId) : undefined,
      ),
    )
    .orderBy(desc(inventoryTransactions.sequence))
    .limit(Math.min(filter.limit ?? 200, 500));
  const showCost = canSeeCost(actor);

  return rows.map(({ transaction, itemName, unitCode }) => ({
    ...transaction,
    itemName,
    unitCode,
    unitCost: showCost ? transaction.unitCost : null,
    totalCost: showCost ? transaction.totalCost : null,
    averageCostAfter: showCost ? transaction.averageCostAfter : null,
  }));
}
