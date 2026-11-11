import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  closeOrderForSettlement,
  countDraftItems,
  readOrderLocation,
} from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import {
  appendSettlementHistory,
  listTenders,
  refreshSettlementTotals,
} from "@/modules/settlements/repositories/settlement-repository";
import { assertCanComplete, assertSettlementOpen } from "@/modules/settlements/rules/settlement-math";
import { assertPermission } from "@/modules/settlements/services/access";
import { lockSettlementWithOrder, settlementEvent } from "@/modules/settlements/services/settlement-service";
import { COMPLETE_SCOPE } from "@/modules/settlements/types";
import { BusinessRuleError } from "@/shared/errors/app-error";
import { compareDecimals } from "@/shared/decimal/decimal";

export type CompleteSettlementResult = {
  settlementId: string;
  orderId: string;
  orderStatus: "CLOSED";
  orderVersion: number;
  tenderedAmount: string;
  tipAmount: string;
  changeDue: string;
  completedAt: string;
  zeroAmount: boolean;
};

/**
 * Completes a settlement and closes its order, in one transaction (README sections 19, 24):
 *
 *   authorize -> claim idempotency key -> lock order, then settlement, check version
 *   -> settlement OPEN, order OPEN -> no DRAFT items -> snapshot still equals the order
 *   amount -> recompute reconciliation, remaining exactly 0.00 -> settlement COMPLETED
 *   + history -> order CLOSED + history -> outbox -> store result
 *
 * A fully comped order (amount 0.00) completes the same way with no tender. A retry with
 * the same key returns the first result; nothing closes twice. Inventory, fulfillment and
 * the Table Session are untouched: the session still completes only through its own
 * explicit physical-departure workflow.
 */
export async function completeSettlement(
  database: Database,
  actor: Actor,
  settlementId: string,
  input: { expectedVersion: number; idempotencyKey: string },
): Promise<CompleteSettlementResult & { replayed: boolean }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.complete");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<CompleteSettlementResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: COMPLETE_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { settlementId, expectedVersion: input.expectedVersion },
      },
      async () => {
        const { order, settlement } = await lockSettlementWithOrder(
          transaction,
          actor,
          settlementId,
          input.expectedVersion,
        );

        assertSettlementOpen(settlement.status);
        assertOrderOpen(order.status);

        // The amount lock keeps these equal; refuse rather than close on a stale amount.
        if (compareDecimals(settlement.orderAmountSnapshot, order.totalDue) !== 0) {
          throw new BusinessRuleError(
            "SETTLEMENT_AMOUNT_STALE",
            "The order amount changed after this settlement opened. Cancel it and settle again.",
          );
        }

        const totals = assertCanComplete(
          settlement.orderAmountSnapshot,
          await listTenders(transaction, settlement.id),
          await countDraftItems(transaction, order.id),
        );
        const now = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, now);

        await refreshSettlementTotals(transaction, settlement, {
          status: "COMPLETED",
          completedAt: now,
          completedByUserId: actor.userId,
          completedBusinessDate: location.businessDate,
          updatedAt: now,
        });
        await appendSettlementHistory(transaction, {
          settlementId: settlement.id,
          status: "COMPLETED",
          reason: compareDecimals(settlement.orderAmountSnapshot, "0") === 0 ? "Zero-amount order" : null,
          userId: actor.userId,
          at: now,
        });

        const closed = await closeOrderForSettlement(transaction, {
          orderId: order.id,
          settlementId: settlement.id,
          userId: actor.userId,
          at: now,
        });

        await writeOutboxEvents(transaction, [
          settlementEvent(actor, "settlement.completed", settlement, now),
          {
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            eventType: "order.closed",
            aggregateType: "order",
            aggregateId: order.id,
            payload: { orderId: order.id, settlementId: settlement.id, tableSessionId: order.tableSessionId },
            occurredAt: now,
          },
        ]);
        await recordAudit(transaction, actor, {
          action: "settlements.completed",
          entityId: settlement.id,
          occurredAt: now,
          before: { status: settlement.status },
          after: {
            orderId: order.id,
            status: "COMPLETED",
            amountDue: settlement.orderAmountSnapshot,
            businessDate: location.businessDate,
          },
        });

        return {
          settlementId: settlement.id,
          orderId: order.id,
          orderStatus: "CLOSED",
          orderVersion: closed.version,
          tenderedAmount: totals.tenderedAmount,
          tipAmount: totals.tipAmount,
          changeDue: totals.changeDue,
          completedAt: now.toISOString(),
          zeroAmount: compareDecimals(settlement.orderAmountSnapshot, "0") === 0,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
