import { and, asc, eq, inArray, max, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItems, orderRefundItems, orderRefunds, settlements } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrderRow, readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertRefundWithinLimits } from "../rules/drawer-math";
import { looksLikeCardNumber, parseMoney } from "../rules/settlement-math";
import type { TenderType } from "../types";
import { assertPermission } from "./access";
import { resolveCashDrawerSession } from "./drawer-service";

// Phase 17 refunds (approved policies B9-B13). Record only: money handed back to a guest
// after the Order CLOSED. The Order, its Settlement, tenders, inventory, fulfillment and the
// Table Session never change. Refunds count on the business date they are recorded.

export const REFUND_SCOPE = "settlements.refund";

export type RecordRefundInput = {
  idempotencyKey: string;
  tenderType: TenderType;
  amount: string;
  taxAmount: string;
  reason: string;
  otherDescription: string | null;
  externalReference: string | null;
  cashDrawerSessionId?: string | null;
  orderItemIds?: string[];
};

export type RefundResult = {
  refundId: string;
  orderId: string;
  refundNumber: number;
  amount: string;
  taxAmount: string;
  remaining: string;
  remainingTax: string;
};

function refundEvent(actor: Actor, eventType: string, refund: { id: string; orderId: string }, at: Date) {
  return {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    eventType,
    aggregateType: "order_refund",
    aggregateId: refund.id,
    payload: { refundId: refund.id, orderId: refund.orderId },
    occurredAt: at,
  };
}

export async function recordRefund(
  database: Database,
  actor: Actor,
  orderId: string,
  input: RecordRefundInput,
): Promise<RefundResult & { replayed: boolean }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.refund");

  const amount = parseMoney(input.amount, "refund amount");
  const taxAmount = parseMoney(input.taxAmount, "tax part");

  if (amount === "0.00") {
    throw new BusinessRuleError("INVALID_AMOUNT", "Enter a refund amount greater than zero.");
  }

  if (input.tenderType === "OTHER" && !input.otherDescription?.trim()) {
    throw new BusinessRuleError("DESCRIPTION_REQUIRED", "Describe how an OTHER refund was given.");
  }

  if (input.tenderType !== "CASH" && input.cashDrawerSessionId) {
    throw new BusinessRuleError("DRAWER_CASH_ONLY", "Only a cash refund comes out of a drawer.");
  }

  if (input.tenderType === "CASH" && input.externalReference) {
    throw new BusinessRuleError("REFERENCE_NOT_ALLOWED", "Cash has no external reference.");
  }

  if ([input.reason, input.otherDescription, input.externalReference].some(looksLikeCardNumber)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  const orderItemIds = [...new Set(input.orderItemIds ?? [])];
  const { idempotencyKey, ...request } = input;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<RefundResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: REFUND_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: { orderId, ...request, amount, taxAmount, orderItemIds: [...orderItemIds].sort() },
      },
      async (idempotencyRecordId) => {
        // The order lock serializes refunds on one order, so their sum can't race past it.
        const order = await lockOrderRow(transaction, actor, orderId);

        if (order.status !== "CLOSED") {
          throw new BusinessRuleError("ORDER_NOT_CLOSED", "Only a closed check can be refunded.");
        }

        const [settlement] = await transaction
          .select({ id: settlements.id })
          .from(settlements)
          .where(and(eq(settlements.orderId, order.id), eq(settlements.status, "COMPLETED")));

        if (!settlement) {
          throw new BusinessRuleError("ORDER_NOT_CLOSED", "Only a closed check can be refunded.");
        }

        const existing = await transaction
          .select({ status: orderRefunds.status, amount: orderRefunds.amount, taxAmount: orderRefunds.taxAmount })
          .from(orderRefunds)
          .where(eq(orderRefunds.orderId, order.id));
        const left = assertRefundWithinLimits(
          { totalDue: order.totalDue, taxTotal: order.taxTotal, existing },
          amount,
          taxAmount,
        );

        if (orderItemIds.length > 0) {
          const items = await transaction
            .select({ id: orderItems.id, status: orderItems.status })
            .from(orderItems)
            .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.id, orderItemIds)));

          if (items.length !== orderItemIds.length || items.some((item) => item.status !== "SUBMITTED")) {
            throw new BusinessRuleError("INVALID_REFUND_ITEMS", "Link only sent, unvoided items of this check.");
          }
        }

        const now = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, now);
        const cashDrawerSessionId =
          input.tenderType === "CASH"
            ? await resolveCashDrawerSession(transaction, actor, input.cashDrawerSessionId ?? null, location.cashDrawerRequired)
            : null;
        const [last] = await transaction
          .select({ value: max(orderRefunds.refundNumber) })
          .from(orderRefunds)
          .where(eq(orderRefunds.orderId, order.id));
        const [refund] = await transaction
          .insert(orderRefunds)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            orderId: order.id,
            settlementId: settlement.id,
            refundNumber: (last?.value ?? 0) + 1,
            tenderType: input.tenderType,
            amount,
            taxAmount,
            reason: input.reason.trim(),
            otherDescription: input.tenderType === "OTHER" ? input.otherDescription!.trim() : null,
            externalReference: input.externalReference?.trim() || null,
            cashDrawerSessionId,
            businessDate: location.businessDate,
            recordedByUserId: actor.userId,
            recordedAt: now,
            idempotencyRecordId,
          })
          .returning();

        if (orderItemIds.length > 0) {
          await transaction
            .insert(orderRefundItems)
            .values(orderItemIds.map((orderItemId) => ({ refundId: refund!.id, orderItemId })));
        }

        await writeOutboxEvents(transaction, [refundEvent(actor, "settlement.refund-recorded", refund!, now)]);
        // The external reference is not copied into the audit trail.
        await recordAudit(transaction, actor, {
          action: "settlements.refund-recorded",
          entityId: refund!.id,
          occurredAt: now,
          after: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            refundNumber: refund!.refundNumber,
            tenderType: refund!.tenderType,
            amount,
            taxAmount,
            businessDate: refund!.businessDate,
          },
        });

        return {
          refundId: refund!.id,
          orderId: order.id,
          refundNumber: refund!.refundNumber,
          amount,
          taxAmount,
          remaining: left.remaining,
          remainingTax: left.remainingTax,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

export async function voidRefund(
  database: Database,
  actor: Actor,
  refundId: string,
  input: { expectedVersion: number; reason: string },
) {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.refund-void");

  if (looksLikeCardNumber(input.reason)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  return withTransaction(database, async (transaction) => {
    const [found] = await transaction
      .select({ orderId: orderRefunds.orderId })
      .from(orderRefunds)
      .where(
        and(
          eq(orderRefunds.id, refundId),
          eq(orderRefunds.organizationId, actor.organizationId),
          eq(orderRefunds.locationId, actor.locationId),
        ),
      );

    if (!found) {
      throw new NotFoundError("refund");
    }

    await lockOrderRow(transaction, actor, found.orderId);

    const [refund] = await transaction.select().from(orderRefunds).where(eq(orderRefunds.id, refundId)).for("update");

    if (refund!.version !== input.expectedVersion) {
      throw new ConcurrencyError("refund", refundId);
    }

    if (refund!.status !== "RECORDED") {
      throw new BusinessRuleError("REFUND_NOT_VOIDABLE", "That refund is already voided.");
    }

    // Voiding cash changes its drawer's count, so the drawer must still be open.
    if (refund!.cashDrawerSessionId) {
      await resolveCashDrawerSession(transaction, actor, refund!.cashDrawerSessionId, true);
    }

    const now = new Date();
    const [updated] = await transaction
      .update(orderRefunds)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: actor.userId,
        voidReason: input.reason.trim(),
        version: sql`${orderRefunds.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orderRefunds.id, refundId))
      .returning();

    await writeOutboxEvents(transaction, [refundEvent(actor, "settlement.refund-voided", refund!, now)]);
    await recordAudit(transaction, actor, {
      action: "settlements.refund-voided",
      entityId: refundId,
      occurredAt: now,
      before: { status: "RECORDED", amount: refund!.amount, tenderType: refund!.tenderType },
      after: { status: "VOIDED", reason: input.reason.trim() },
    });

    return { refundId, status: updated!.status, version: updated!.version };
  });
}

/** Refunds of an order, oldest first. References are returned only with card metadata. */
export async function listRefundsForOrder(executor: DatabaseExecutor, actor: Actor, orderId: string) {
  assertPermission(actor, "settlements.view");

  const rows = await executor
    .select()
    .from(orderRefunds)
    .where(
      and(
        eq(orderRefunds.orderId, orderId),
        eq(orderRefunds.organizationId, actor.organizationId),
        eq(orderRefunds.locationId, actor.locationId),
      ),
    )
    .orderBy(asc(orderRefunds.refundNumber));
  const canSeeReference = actor.permissions.has("settlements.view-card-metadata");

  return rows.map((row) => ({
    id: row.id,
    refundNumber: row.refundNumber,
    status: row.status,
    tenderType: row.tenderType,
    amount: row.amount,
    taxAmount: row.taxAmount,
    reason: row.reason,
    otherDescription: row.otherDescription,
    externalReference: canSeeReference ? row.externalReference : null,
    businessDate: row.businessDate,
    recordedAt: row.recordedAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    version: row.version,
  }));
}
