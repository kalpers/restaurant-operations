import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItems } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import type { Actor } from "@/modules/auth/types";
import { lockOrder } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { planSplitBySeat } from "@/modules/orders/rules/seats";
import { assertPermission } from "@/modules/orders/services/access";
import { createOrderInTransaction } from "@/modules/orders/services/order-service";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { BusinessRuleError } from "@/shared/errors/app-error";
import { moveItemsInTransaction } from "@/workflows/move-order-items/move-order-items";

/** Idempotency scope for splitting a check by seat. */
export const SPLIT_BY_SEAT_SCOPE = "orders.split-by-seat";

export type SplitBySeatResult = {
  sourceOrderId: string;
  sourceVersion: number;
  stayingSeat: number;
  checks: { seat: number; orderId: string; orderNumber: number; version: number; itemIds: string[] }[];
};

/**
 * Phase 29 (policies 9, 10; amendments 1, 2): splits a check into one check per seat, in one
 * transaction. The check keeps its "Table" items and its lowest seat; every other seat with
 * items goes to a new check on the same Table Session, lowest first, through an ordinary
 * Phase 17 move (transfer rows, recompute, `order.items-moved`, `orders.items-moved` audit).
 * Nothing is shared. A retry with the same key returns the first result and moves nothing.
 */
export async function splitCheckBySeat(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { expectedVersion: number; idempotencyKey: string },
): Promise<SplitBySeatResult & { replayed: boolean }> {
  assertPermission(actor, "orders.move-items");
  assertPermission(actor, "orders.create");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<SplitBySeatResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: SPLIT_BY_SEAT_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { orderId, expectedVersion: input.expectedVersion },
      },
      async () => {
        const source = await lockOrder(transaction, actor, orderId, input.expectedVersion);

        assertOrderOpen(source.status);

        if (source.tableSessionId === null || source.orderType === "TAKEOUT") {
          throw new BusinessRuleError("TAKEOUT_CANNOT_SPLIT", "Takeout orders can't be split into checks.");
        }

        await assertNoOpenSettlement(transaction, source.id);

        const items = await transaction
          .select({ id: orderItems.id, status: orderItems.status, seatNumber: orderItems.seatNumber })
          .from(orderItems)
          .where(eq(orderItems.orderId, source.id))
          .for("update");
        const plan = planSplitBySeat(items);
        const checks: SplitBySeatResult["checks"] = [];
        let sourceVersion = source.version;

        for (const move of plan.moves) {
          const created = await createOrderInTransaction(transaction, actor, {
            orderType: source.orderType as "DINE_IN" | "BAR",
            tableSessionId: source.tableSessionId,
          });
          const target = await lockOrder(transaction, actor, created.id, created.version);
          const moved = await moveItemsInTransaction(transaction, actor, source, target, move.itemIds);

          sourceVersion = moved.sourceVersion;
          checks.push({
            seat: move.seat,
            orderId: moved.targetOrderId,
            orderNumber: moved.targetOrderNumber,
            version: moved.targetVersion,
            itemIds: move.itemIds,
          });
        }

        return { sourceOrderId: source.id, sourceVersion, stayingSeat: plan.stayingSeat, checks };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
