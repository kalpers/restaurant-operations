import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  inventoryBalances,
  inventoryItemLocations,
  inventoryItems,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrders,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";

import { extendCost } from "../rules/costing";
import { suggestPurchaseLines, type SuggestionCandidate } from "../rules/replenishment";
import { assertPermission, canSeeCost } from "./access";
import { addPurchaseOrderLineIn, createPurchaseOrderIn } from "./purchase-order-service";

// Phase 19 suggested purchase orders (decisions D7/D8, policies 15-18). The suggestion follows
// the Phase 8 replenishment rule minus what is already on order, and uses each stocked item's
// preferred supplier item. Creating them makes DRAFT orders only, through the ordinary purchase
// order service; nothing is submitted and no stock moves.

export const SUGGEST_SCOPE = "purchasing.suggest";

const OPEN_PO_STATUSES = ["DRAFT", "SUBMITTED", "PARTIALLY_RECEIVED"] as const;

type CandidateRow = SuggestionCandidate & {
  code: string;
  name: string;
  baseUnitCode: string;
};

async function loadCandidates(executor: DatabaseExecutor, actor: Actor): Promise<CandidateRow[]> {
  const rows = await executor
    .select({
      inventoryItemId: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      baseUnitCode: unitsOfMeasure.code,
      parLevel: inventoryItemLocations.parLevel,
      reorderLevel: inventoryItemLocations.reorderLevel,
      reorderTarget: inventoryItemLocations.reorderTarget,
      quantityOnHand: inventoryBalances.quantityOnHand,
      preferredSupplierItemId: inventoryItemLocations.preferredSupplierItemId,
      preferredSupplierId: supplierItems.supplierId,
      preferredBaseUnits: supplierItems.baseUnitsPerPurchase,
      preferredActive: sql<boolean | null>`${supplierItems.active} AND ${suppliers.active}`,
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
    .leftJoin(supplierItems, eq(supplierItems.id, inventoryItemLocations.preferredSupplierItemId))
    .leftJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
    .where(
      and(
        eq(inventoryItemLocations.locationId, actor.locationId),
        eq(inventoryItemLocations.active, true),
        eq(inventoryItems.organizationId, actor.organizationId),
        eq(inventoryItems.active, true),
      ),
    )
    .orderBy(asc(inventoryItems.name), asc(inventoryItems.id));

  if (rows.length === 0) {
    return [];
  }

  const received = executor
    .select({
      lineId: purchaseOrderReceiptLines.purchaseOrderLineId,
      quantity: sql<string>`sum(${purchaseOrderReceiptLines.receivedQuantity})`.as("quantity"),
    })
    .from(purchaseOrderReceiptLines)
    .groupBy(purchaseOrderReceiptLines.purchaseOrderLineId)
    .as("received");
  const outstanding = await executor
    .select({
      inventoryItemId: purchaseOrderLines.inventoryItemId,
      quantity: sql<string>`sum(greatest(${purchaseOrderLines.orderedQuantity} - coalesce(${received.quantity}, 0), 0) * ${purchaseOrderLines.baseUnitsPerPurchase})::numeric(14,4)::text`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
    .where(
      and(
        eq(purchaseOrders.organizationId, actor.organizationId),
        eq(purchaseOrders.locationId, actor.locationId),
        inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]),
        inArray(
          purchaseOrderLines.inventoryItemId,
          rows.map((row) => row.inventoryItemId),
        ),
      ),
    )
    .groupBy(purchaseOrderLines.inventoryItemId);
  const onOrder = new Map(outstanding.map((row) => [row.inventoryItemId, row.quantity]));

  return rows.map((row) => ({
    inventoryItemId: row.inventoryItemId,
    code: row.code,
    name: row.name,
    baseUnitCode: row.baseUnitCode,
    quantityOnHand: toScale(row.quantityOnHand ?? "0", 4),
    thresholds: { parLevel: row.parLevel, reorderLevel: row.reorderLevel, reorderTarget: row.reorderTarget },
    outstandingBaseQuantity: onOrder.get(row.inventoryItemId) ?? "0.0000",
    preferred:
      row.preferredSupplierItemId && row.preferredSupplierId && row.preferredBaseUnits && row.preferredActive
        ? {
            supplierItemId: row.preferredSupplierItemId,
            supplierId: row.preferredSupplierId,
            baseUnitsPerPurchase: row.preferredBaseUnits,
          }
        : null,
  }));
}

export type SuggestedOrders = {
  suppliers: {
    supplierId: string;
    supplierName: string;
    lines: {
      inventoryItemId: string;
      code: string;
      name: string;
      quantityOnHand: string;
      onOrderBaseQuantity: string;
      needBaseQuantity: string;
      baseUnitCode: string;
      supplierItemId: string;
      purchaseUnitCode: string;
      orderedQuantity: string;
      /** Null without `inventory.cost.view`, or when the supplier item has no cost. */
      estimatedLineCost: string | null;
    }[];
  }[];
  withoutSupplier: { inventoryItemId: string; code: string; name: string; needBaseQuantity: string; baseUnitCode: string }[];
};

async function buildSuggestion(executor: DatabaseExecutor, actor: Actor): Promise<SuggestedOrders> {
  const candidates = await loadCandidates(executor, actor);
  const byId = new Map(candidates.map((row) => [row.inventoryItemId, row]));
  const { bySupplier, withoutSupplier } = suggestPurchaseLines(candidates);
  const supplierItemIds = [...bySupplier.values()].flat().map((line) => line.supplierItemId);
  const details =
    supplierItemIds.length === 0
      ? []
      : await executor
          .select({
            id: supplierItems.id,
            supplierName: suppliers.name,
            purchaseUnitCode: unitsOfMeasure.code,
            lastUnitCost: supplierItems.lastUnitCost,
          })
          .from(supplierItems)
          .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
          .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, supplierItems.purchaseUnitId))
          .where(inArray(supplierItems.id, supplierItemIds));
  const detail = new Map(details.map((row) => [row.id, row]));
  const showCost = canSeeCost(actor);

  return {
    suppliers: [...bySupplier.entries()]
      .map(([supplierId, lines]) => ({
        supplierId,
        supplierName: detail.get(lines[0]!.supplierItemId)!.supplierName,
        lines: lines.map((line) => {
          const item = byId.get(line.inventoryItemId)!;
          const supplierItem = detail.get(line.supplierItemId)!;

          return {
            inventoryItemId: line.inventoryItemId,
            code: item.code,
            name: item.name,
            quantityOnHand: item.quantityOnHand,
            onOrderBaseQuantity: item.outstandingBaseQuantity,
            needBaseQuantity: line.needBaseQuantity,
            baseUnitCode: item.baseUnitCode,
            supplierItemId: line.supplierItemId,
            purchaseUnitCode: supplierItem.purchaseUnitCode,
            orderedQuantity: line.orderedQuantity,
            estimatedLineCost:
              showCost && supplierItem.lastUnitCost !== null
                ? extendCost(line.orderedQuantity, supplierItem.lastUnitCost)
                : null,
          };
        }),
      }))
      .sort((a, b) => a.supplierName.localeCompare(b.supplierName) || a.supplierId.localeCompare(b.supplierId)),
    withoutSupplier: withoutSupplier.map((entry) => {
      const item = byId.get(entry.inventoryItemId)!;

      return {
        inventoryItemId: entry.inventoryItemId,
        code: item.code,
        name: item.name,
        needBaseQuantity: entry.needBaseQuantity,
        baseUnitCode: item.baseUnitCode,
      };
    }),
  };
}

/** Policy 16: what would go on draft orders now. Writes nothing. */
export async function previewSuggestedOrders(executor: DatabaseExecutor, actor: Actor): Promise<SuggestedOrders> {
  assertPermission(actor, "purchasing.manage");

  return buildSuggestion(executor, actor);
}

export type CreatedSuggestedOrders = {
  purchaseOrders: { id: string; poNumber: string; supplierId: string; lineCount: number }[];
  withoutSupplierCount: number;
};

/** Policy 17: one DRAFT per supplier, in one transaction; a retry with the key returns the same. */
export async function createSuggestedOrders(
  database: Database,
  actor: Actor,
  input: { idempotencyKey: string },
): Promise<{ replayed: boolean } & CreatedSuggestedOrders> {
  assertPermission(actor, "purchasing.manage");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: SUGGEST_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { locationId: actor.locationId },
      },
      async (): Promise<CreatedSuggestedOrders> => {
        // Serializes concurrent suggestions at a location, so two can't both order the shortfall.
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`purchasing.suggest:${actor.locationId}`}))`);

        const suggestion = await buildSuggestion(transaction, actor);
        const created: CreatedSuggestedOrders["purchaseOrders"] = [];

        for (const group of suggestion.suppliers) {
          const order = await createPurchaseOrderIn(transaction, actor, {
            supplierId: group.supplierId,
            expectedAt: null,
            notes: "Suggested from low stock.",
          });
          let version = order.version;

          for (const line of group.lines) {
            await addPurchaseOrderLineIn(transaction, actor, order.id, {
              supplierItemId: line.supplierItemId,
              orderedQuantity: line.orderedQuantity,
              unitPrice: null,
              expectedVersion: version,
            });
            version += 1;
          }

          created.push({ id: order.id, poNumber: order.poNumber, supplierId: group.supplierId, lineCount: group.lines.length });
        }

        if (created.length > 0) {
          await recordAudit(transaction, actor, {
            action: "purchasing.suggested-orders-created",
            entityId: actor.locationId,
            details: {
              poNumbers: created.map((order) => order.poNumber),
              lineCount: created.reduce((sum, order) => sum + order.lineCount, 0),
            },
          });
        }

        return { purchaseOrders: created, withoutSupplierCount: suggestion.withoutSupplier.length };
      },
    ),
  );

  return { replayed: outcome.replayed, ...outcome.response };
}
