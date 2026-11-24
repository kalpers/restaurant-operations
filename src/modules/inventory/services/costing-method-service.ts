import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  inventoryBalances,
  inventoryCostingChanges,
  inventoryItems,
  inventoryLotMovements,
  inventoryLots,
  inventoryTransactions,
} from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { isPositiveDecimal } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { extendCost } from "../rules/costing";
import {
  averageFromLots,
  carryOverToLots,
  sumKnown,
  type CostingChangeReason,
  type CostingMethod,
} from "../rules/lot-costing";
import { assertPermission } from "./access";
import { latestSequence } from "./posting-service";

// Phase 37 (policies 2 and 3, D2, D3): changing an item's costing method. Organization-wide,
// under `inventory.configure`, with a reason code. The value of stock on hand carries over:
// to `LOT`, open lots are carried at the location's current average; back to weighted
// average, the average becomes the lots' value ÷ quantity. One append-only record per
// location; no ledger row. Every balance of the item is locked (in location order) for the
// whole change, and a posting reads the method under that lock.

/** True while a CONSUME of the item went beyond its lots and no increase has covered it yet. */
async function hasOpenShortfall(transaction: Parameters<Parameters<typeof withTransaction>[1]>[0], inventoryItemId: string) {
  const settled = sql`coalesce((SELECT sum(s.base_quantity_delta) FROM inventory_lot_movements s WHERE s.settles_movement_id = ${inventoryLotMovements.id}), 0)`;
  const [row] = await transaction
    .select({ id: inventoryLotMovements.id })
    .from(inventoryLotMovements)
    .innerJoin(inventoryTransactions, eq(inventoryTransactions.id, inventoryLotMovements.inventoryTransactionId))
    .where(
      and(
        isNull(inventoryLotMovements.lotId),
        lt(inventoryLotMovements.baseQuantityDelta, "0"),
        eq(inventoryTransactions.inventoryItemId, inventoryItemId),
        sql`-${inventoryLotMovements.baseQuantityDelta} - ${settled} > 0`,
      ),
    )
    .limit(1);

  return row !== undefined;
}

export async function changeCostingMethod(
  database: Database,
  actor: Actor,
  inventoryItemId: string,
  input: { method: CostingMethod; reasonCode: CostingChangeReason; expectedVersion: number },
  now = new Date(),
) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    const [item] = await transaction
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.organizationId, actor.organizationId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("inventory item");
    }

    if (item.version !== input.expectedVersion) {
      throw new ConcurrencyError("inventory item", inventoryItemId);
    }

    if (item.costingMethod === input.method) {
      throw new BusinessRuleError("COSTING_METHOD_UNCHANGED", "This item already uses that costing method.");
    }

    if (input.method === "LOT" && !item.lotTracked) {
      throw new BusinessRuleError("LOT_COSTING_NEEDS_LOTS", "Turn lot tracking on before costing this item by lot.");
    }

    const balances = await transaction
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.inventoryItemId, inventoryItemId))
      .orderBy(asc(inventoryBalances.locationId))
      .for("update");

    // A shortfall from before the switch has no cost, so the lots couldn't carry the stock's
    // value; the next delivery or a count covers it first.
    if (input.method === "LOT" && (await hasOpenShortfall(transaction, inventoryItemId))) {
      throw new BusinessRuleError(
        "LOT_COSTING_SHORTFALL_OPEN",
        "Some of this item was used beyond its lots. Receive or count it before costing it by lot.",
      );
    }

    for (const balance of balances) {
      const lots = await transaction
        .select({ id: inventoryLots.id, quantityRemaining: inventoryLots.quantityRemaining })
        .from(inventoryLots)
        .where(
          and(
            eq(inventoryLots.inventoryItemId, inventoryItemId),
            eq(inventoryLots.locationId, balance.locationId),
            input.method === "LOT" ? gt(inventoryLots.quantityRemaining, "0") : sql`true`,
          ),
        )
        .orderBy(asc(inventoryLots.sequenceNumber))
        .for("update");
      let valueBefore: string | null;
      let valueAfter: string | null;
      let averageAfter: string | null;

      if (input.method === "LOT") {
        const carried = carryOverToLots(lots, balance.weightedAverageCost);

        for (const lot of carried) {
          await transaction
            .update(inventoryLots)
            .set({ carryingUnitCost: lot.carryingUnitCost, valueRemaining: lot.valueRemaining, version: sql`${inventoryLots.version} + 1`, updatedAt: now })
            .where(eq(inventoryLots.id, lot.id));
        }

        valueBefore =
          balance.weightedAverageCost !== null && isPositiveDecimal(balance.quantityOnHand)
            ? extendCost(balance.quantityOnHand, balance.weightedAverageCost)
            : null;
        valueAfter = sumKnown(carried.map((lot) => lot.valueRemaining)) ?? "0.0000";
        averageAfter = balance.weightedAverageCost;
      } else {
        valueBefore = balance.stockValue;
        averageAfter = averageFromLots(balance.stockValue, balance.quantityOnHand, balance.weightedAverageCost);
        valueAfter =
          averageAfter !== null && isPositiveDecimal(balance.quantityOnHand) ? extendCost(balance.quantityOnHand, averageAfter) : null;

        await transaction
          .update(inventoryLots)
          .set({ carryingUnitCost: null, valueRemaining: null, version: sql`${inventoryLots.version} + 1`, updatedAt: now })
          .where(and(eq(inventoryLots.inventoryItemId, inventoryItemId), eq(inventoryLots.locationId, balance.locationId)));
      }

      await transaction
        .update(inventoryBalances)
        .set({
          weightedAverageCost: averageAfter,
          stockValue: input.method === "LOT" ? valueAfter : null,
          version: sql`${inventoryBalances.version} + 1`,
          updatedAt: now,
        })
        .where(eq(inventoryBalances.id, balance.id));

      const sequence = await latestSequence(transaction, inventoryItemId, balance.locationId);

      await transaction.insert(inventoryCostingChanges).values({
        organizationId: actor.organizationId,
        inventoryItemId,
        locationId: balance.locationId,
        fromMethod: item.costingMethod,
        toMethod: input.method,
        quantityOnHand: balance.quantityOnHand,
        valueBefore,
        valueAfter,
        averageCostAfter: averageAfter,
        lastTransactionSequence: sequence === 0 ? null : sequence,
        reasonCode: input.reasonCode,
        changedByUserId: actor.userId,
        changedAt: now,
      });
    }

    const [updated] = await transaction
      .update(inventoryItems)
      .set({ costingMethod: input.method, version: sql`${inventoryItems.version} + 1`, updatedAt: now })
      .where(eq(inventoryItems.id, inventoryItemId))
      .returning({ version: inventoryItems.version });

    await recordAudit(transaction, actor, {
      action: "inventory.costing-method-changed",
      entityId: inventoryItemId,
      before: { costingMethod: item.costingMethod },
      after: {
        itemCode: item.code,
        costingMethod: input.method,
        reasonCode: input.reasonCode,
        locationCount: balances.length,
      },
    });

    return { version: updated!.version, costingMethod: input.method, locations: balances.length };
  });
}
