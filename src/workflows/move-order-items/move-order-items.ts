import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItems, orderItemTransfers } from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrder, recomputeAndBumpOrder } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { assertPermission } from "@/modules/orders/services/access";
import { createOrderInTransaction } from "@/modules/orders/services/order-service";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

/** Idempotency scope for moving items between checks. */
export const MOVE_ITEMS_SCOPE = "orders.move-items";

export type MoveItemsInput = {
  itemIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
  /** An existing OPEN order on the same Table Session, or a new check there. */
  target: { orderId: string; expectedVersion: number } | { newCheck: true };
};

export type MoveItemsResult = {
  sourceOrderId: string;
  sourceVersion: number;
  targetOrderId: string;
  targetOrderNumber: number;
  targetVersion: number;
  movedItemIds: string[];
  transferGroupId: string;
};

type Locked = Awaited<ReturnType<typeof lockOrder>>;

/** Both orders are locked in UUID order, so two opposite moves can't deadlock. */
async function lockBoth(
  transaction: DatabaseTransaction,
  actor: Actor,
  source: { id: string; version: number },
  target: { id: string; version: number },
): Promise<[Locked, Locked]> {
  if (source.id < target.id) {
    const first = await lockOrder(transaction, actor, source.id, source.version);

    return [first, await lockOrder(transaction, actor, target.id, target.version)];
  }

  const second = await lockOrder(transaction, actor, target.id, target.version);

  return [await lockOrder(transaction, actor, source.id, source.version), second];
}

/**
 * Split checks (Phase 17 policy C): moves draft and sent items from one OPEN order to another
 * OPEN order on the same Table Session (or a new check there), in one transaction. Snapshots,
 * modifiers, consumption and kitchen work are unchanged; item discounts travel with their
 * item; order discounts stay and both orders' totals and tax are recomputed. A retry with the
 * same key returns the first result and moves nothing.
 */
export async function moveOrderItems(
  database: Database,
  actor: Actor,
  sourceOrderId: string,
  input: MoveItemsInput,
): Promise<MoveItemsResult & { replayed: boolean }> {
  assertPermission(actor, "orders.move-items");

  if ("newCheck" in input.target) {
    assertPermission(actor, "orders.create");
  }

  const itemIds = [...new Set(input.itemIds)];

  if (itemIds.length === 0) {
    throw new BusinessRuleError("NOTHING_TO_MOVE", "Choose at least one item to move.");
  }

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<MoveItemsResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: MOVE_ITEMS_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { sourceOrderId, itemIds: [...itemIds].sort(), expectedVersion: input.expectedVersion, target: input.target },
      },
      async () => {
        let source: Locked;
        let target: Locked;

        if ("newCheck" in input.target) {
          source = await lockOrder(transaction, actor, sourceOrderId, input.expectedVersion);
          assertOrderOpen(source.status);

          if (source.tableSessionId === null || source.orderType === "TAKEOUT") {
            throw new BusinessRuleError("TAKEOUT_CANNOT_SPLIT", "Takeout orders can't be split into checks.");
          }

          const created = await createOrderInTransaction(transaction, actor, {
            orderType: source.orderType as "DINE_IN" | "BAR",
            tableSessionId: source.tableSessionId,
          });

          target = await lockOrder(transaction, actor, created.id, created.version);
        } else {
          if (input.target.orderId === sourceOrderId) {
            throw new BusinessRuleError("SAME_ORDER", "Choose a different check to move the items to.");
          }

          [source, target] = await lockBoth(
            transaction,
            actor,
            { id: sourceOrderId, version: input.expectedVersion },
            { id: input.target.orderId, version: input.target.expectedVersion },
          );
        }

        assertOrderOpen(source.status);
        assertOrderOpen(target.status);

        if (source.tableSessionId === null || source.orderType === "TAKEOUT" || target.orderType === "TAKEOUT") {
          throw new BusinessRuleError("TAKEOUT_CANNOT_SPLIT", "Takeout orders can't be split into checks.");
        }

        if (target.tableSessionId !== source.tableSessionId) {
          throw new BusinessRuleError("DIFFERENT_SESSION", "Items can only move between checks at the same table.");
        }

        await assertNoOpenSettlement(transaction, source.id);
        await assertNoOpenSettlement(transaction, target.id);

        const rows = await transaction
          .select({ id: orderItems.id, status: orderItems.status })
          .from(orderItems)
          .where(and(eq(orderItems.orderId, source.id), inArray(orderItems.id, itemIds)))
          .for("update");

        if (rows.length !== itemIds.length) {
          throw new NotFoundError("order item");
        }

        if (rows.some((row) => row.status === "VOIDED")) {
          throw new BusinessRuleError("ITEM_VOIDED", "A voided item can't be moved.");
        }

        const transferGroupId = randomUUID();

        // The transfer rows first: the database lets a sent item change order only alongside one.
        await transaction.insert(orderItemTransfers).values(
          itemIds.map((orderItemId) => ({
            organizationId: actor.organizationId,
            orderItemId,
            fromOrderId: source.id,
            toOrderId: target.id,
            transferGroupId,
            movedByUserId: actor.userId,
          })),
        );
        await transaction
          .update(orderItems)
          .set({ orderId: target.id, updatedAt: new Date() })
          .where(inArray(orderItems.id, itemIds));

        const updatedSource = await recomputeAndBumpOrder(transaction, source.id);
        const updatedTarget = await recomputeAndBumpOrder(transaction, target.id);
        const at = new Date();

        await writeOutboxEvents(
          transaction,
          [source.id, target.id].map((orderId) => ({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            eventType: "order.items-moved",
            aggregateType: "order",
            aggregateId: orderId,
            payload: { fromOrderId: source.id, toOrderId: target.id, orderItemIds: itemIds },
            occurredAt: at,
          })),
        );
        await recordAudit(transaction, actor, {
          action: "orders.items-moved",
          entityId: source.id,
          occurredAt: at,
          after: {
            fromOrderNumber: source.orderNumber,
            toOrderId: target.id,
            toOrderNumber: target.orderNumber,
            orderItemIds: itemIds,
            itemCount: itemIds.length,
          },
        });

        return {
          sourceOrderId: source.id,
          sourceVersion: updatedSource.version,
          targetOrderId: target.id,
          targetOrderNumber: target.orderNumber,
          targetVersion: updatedTarget.version,
          movedItemIds: itemIds,
          transferGroupId,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
