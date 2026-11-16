import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  inventoryBalances,
  inventoryItemLocations,
  inventoryItems,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrders,
  purchasingForecastItems,
  purchasingForecastLines,
  purchasingForecasts,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";

import { extendCost } from "../rules/costing";
import {
  suggestForecastPurchaseLines,
  suggestPurchaseLines,
  type SuggestionBasis,
  type SuggestionCandidate,
} from "../rules/replenishment";
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
    lines: ({
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
    } & ForecastLineFields)[];
  }[];
  withoutSupplier: ({
    inventoryItemId: string;
    code: string;
    name: string;
    needBaseQuantity: string;
    baseUnitCode: string;
  } & ForecastLineFields)[];
  /** Phase 25: present on the forecast basis only. */
  forecast?: { fromDate: string; throughDate: string; dates: ForecastBasisInput["dates"] };
};

/** Phase 25 policy 11: present on the forecast basis only, so the par response is unchanged. */
type ForecastLineFields = {
  basis?: SuggestionBasis;
  /** Base units the forecast uses through the chosen date; null on the PAR basis. */
  forecastUsageBaseQuantity?: string | null;
  reorderFloor?: string | null;
};

/**
 * Phase 25 (D6, D9): the forecast usage the `forecast-items` workflow works out and hands to
 * Inventory. Inventory never reads orders, recipes, menus or schedules itself.
 */
export type ForecastBasisInput = {
  fromDate: string;
  throughDate: string;
  /** Base units per inventory item. */
  usage: ReadonlyMap<string, string>;
  dates: { businessDate: string; status: string; sampleDates: string[] }[];
};

/** Phase 25 policy 14: what is stored with drafts made on the forecast basis. */
export type ForecastSnapshotInput = ForecastBasisInput & {
  items: {
    businessDate: string;
    menuItemId: string;
    status: string;
    portions: string | null;
    newItem: boolean;
    recipeVersionId: string | null;
  }[];
  method: Record<string, unknown>;
};

async function buildSuggestion(
  executor: DatabaseExecutor,
  actor: Actor,
  forecast?: ForecastBasisInput,
): Promise<SuggestedOrders> {
  const candidates = await loadCandidates(executor, actor);
  const byId = new Map(candidates.map((row) => [row.inventoryItemId, row]));
  // Phase 25 policy 12: on the forecast basis each item uses its forecast usage, or par.
  const { bySupplier, withoutSupplier } = forecast
    ? suggestForecastPurchaseLines(
        candidates.map((row) => ({ ...row, forecastUsage: forecast.usage.get(row.inventoryItemId) ?? null })),
      )
    : suggestPurchaseLines(candidates);
  const forecastFields = (inventoryItemId: string, line: object): ForecastLineFields => {
    if (!forecast || !("basis" in line)) {
      return {};
    }

    const basis = line.basis as SuggestionBasis;

    return {
      basis,
      forecastUsageBaseQuantity: basis === "FORECAST" ? toScale(forecast.usage.get(inventoryItemId)!, 4) : null,
      reorderFloor: byId.get(inventoryItemId)!.thresholds.reorderLevel,
    };
  };
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
            ...forecastFields(line.inventoryItemId, line),
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
        ...forecastFields(entry.inventoryItemId, entry),
      };
    }),
    ...(forecast
      ? { forecast: { fromDate: forecast.fromDate, throughDate: forecast.throughDate, dates: forecast.dates } }
      : {}),
  };
}

/**
 * Policy 16: what would go on draft orders now. Writes nothing. Phase 25 policy 11: with a
 * forecast, on the forecast basis.
 */
export async function previewSuggestedOrders(
  executor: DatabaseExecutor,
  actor: Actor,
  forecast?: ForecastBasisInput,
): Promise<SuggestedOrders> {
  assertPermission(actor, "purchasing.manage");

  return buildSuggestion(executor, actor, forecast);
}

export type CreatedSuggestedOrders = {
  purchaseOrders: { id: string; poNumber: string; supplierId: string; lineCount: number }[];
  withoutSupplierCount: number;
};

/** Policy 17: one DRAFT per supplier, in one transaction; a retry with the key returns the same. */
export async function createSuggestedOrders(
  database: Database,
  actor: Actor,
  input: {
    idempotencyKey: string;
    /**
     * Phase 25 policy 13: the forecast basis. `compute` works the forecast out again inside
     * this transaction; the calling workflow supplies it.
     */
    forecast?: {
      throughDate: string;
      compute: (transaction: DatabaseTransaction) => Promise<ForecastSnapshotInput>;
    };
  },
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
        request: input.forecast
          ? { locationId: actor.locationId, basis: "FORECAST", throughDate: input.forecast.throughDate }
          : { locationId: actor.locationId },
      },
      async (): Promise<CreatedSuggestedOrders> => {
        // Serializes concurrent suggestions at a location, so two can't both order the shortfall.
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`purchasing.suggest:${actor.locationId}`}))`);

        const snapshot = input.forecast ? await input.forecast.compute(transaction) : undefined;
        const suggestion = await buildSuggestion(transaction, actor, snapshot);
        const purchasingForecastId = snapshot ? await storeForecast(transaction, actor, snapshot, suggestion) : null;
        const created: CreatedSuggestedOrders["purchaseOrders"] = [];

        for (const group of suggestion.suppliers) {
          const order = await createPurchaseOrderIn(transaction, actor, {
            supplierId: group.supplierId,
            expectedAt: null,
            notes: snapshot ? `Suggested from the forecast through ${snapshot.throughDate}.` : "Suggested from low stock.",
            purchasingForecastId,
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
              ...(snapshot ? { basis: "FORECAST", throughDate: snapshot.throughDate, purchasingForecastId } : {}),
            },
          });
        }

        return { purchaseOrders: created, withoutSupplierCount: suggestion.withoutSupplier.length };
      },
    ),
  );

  return { replayed: outcome.replayed, ...outcome.response };
}

/**
 * Phase 25 policy 14 (D7): stores the forecast behind forecast-based drafts, append-only, in
 * the drafts' transaction: the item forecast per date and the suggested lines.
 */
async function storeForecast(
  transaction: DatabaseTransaction,
  actor: Actor,
  snapshot: ForecastSnapshotInput,
  suggestion: SuggestedOrders,
): Promise<string> {
  const [forecast] = await transaction
    .insert(purchasingForecasts)
    .values({
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      createdByUserId: actor.userId,
      fromDate: snapshot.fromDate,
      throughDate: snapshot.throughDate,
      method: { ...snapshot.method, dates: snapshot.dates },
    })
    .returning({ id: purchasingForecasts.id });
  const id = forecast!.id;

  for (let start = 0; start < snapshot.items.length; start += 500) {
    await transaction.insert(purchasingForecastItems).values(
      snapshot.items.slice(start, start + 500).map((item) => ({
        purchasingForecastId: id,
        businessDate: item.businessDate,
        menuItemId: item.menuItemId,
        status: item.status,
        portions: item.portions,
        newItem: item.newItem,
        recipeVersionId: item.recipeVersionId,
      })),
    );
  }

  const candidates = new Map((await loadCandidates(transaction, actor)).map((row) => [row.inventoryItemId, row]));
  const lines: {
    inventoryItemId: string;
    needBaseQuantity: string;
    basis?: SuggestionBasis;
    forecastUsageBaseQuantity?: string | null;
    supplierItemId: string | null;
    orderedQuantity: string | null;
  }[] = [
    ...suggestion.suppliers.flatMap((group) => group.lines),
    ...suggestion.withoutSupplier.map((entry) => ({ ...entry, supplierItemId: null, orderedQuantity: null })),
  ];

  if (lines.length > 0) {
    await transaction.insert(purchasingForecastLines).values(
      lines.map((line) => {
        const candidate = candidates.get(line.inventoryItemId)!;

        return {
          purchasingForecastId: id,
          inventoryItemId: line.inventoryItemId,
          basis: line.basis!,
          forecastUsage: line.forecastUsageBaseQuantity ?? null,
          reorderFloor: candidate.thresholds.reorderLevel,
          quantityOnHand: candidate.quantityOnHand,
          onOrder: candidate.outstandingBaseQuantity,
          need: line.needBaseQuantity,
          supplierItemId: line.supplierItemId,
          orderedQuantity: line.orderedQuantity,
        };
      }),
    );
  }

  return id;
}
