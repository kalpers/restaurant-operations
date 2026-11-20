import { and, asc, eq, inArray, max, sql } from "drizzle-orm";

import { orderItems, orderRefundItems, orderRefunds, orders, settlements, settlementTenders, tipDistributions } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrderRow, readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertRefundWithinLimits, assertTipRefundWithinLimits } from "../rules/drawer-math";
import { formatGiftCardNumber } from "../rules/gift-card-code";
import { assertCardRefundWithinLimits } from "../rules/gift-card-math";
import { looksLikeCardNumber, parseMoney } from "../rules/settlement-math";
import type { TenderType } from "../types";
import { assertPermission } from "./access";
import { resolveCashDrawerSession } from "./drawer-service";
import { assertCardActive, lockGiftCard, postGiftCardEntry, readGiftCardProgram, type GiftCardRow } from "./gift-card-ledger";

// Phase 17 refunds (approved policies B9-B13). Record only: money handed back to a guest
// after the Order CLOSED. The Order, its Settlement, tenders, inventory, fulfillment and the
// Table Session never change. Refunds count on the business date they are recorded.

export const REFUND_SCOPE = "settlements.refund";

export type RecordRefundInput = {
  idempotencyKey: string;
  tenderType: TenderType;
  amount: string;
  taxAmount: string;
  /** Phase 20 (policy 18): a tip handed back, CASH or EXTERNAL_CARD only. */
  tipAmount?: string;
  reason: string;
  otherDescription: string | null;
  externalReference: string | null;
  cashDrawerSessionId?: string | null;
  orderItemIds?: string[];
  /** Phase 31 (policy 10): the card that paid this check, for a GIFT_CARD refund. */
  giftCardId?: string | null;
};

/**
 * Phase 33 (amendment 4): what a workflow adds once the refund row is written, in the same
 * transaction, such as loyalty points taken back. Its figures go into the refund's audit row
 * and its response.
 */
export type RefundHook = (
  transaction: DatabaseTransaction,
  refund: { id: string; orderId: string; amount: string; taxAmount: string },
  at: Date,
) => Promise<Record<string, number>>;

export type RefundResult = {
  refundId: string;
  orderId: string;
  refundNumber: number;
  amount: string;
  taxAmount: string;
  tipAmount: string;
  remaining: string;
  remainingTax: string;
  remainingTips: string;
};

/**
 * Phase 20 (policy 18): a tip refund changes the business date's tip pool, so it is refused
 * while that date's distribution is FINALIZED. Void the distribution and redo it after.
 */
async function assertTipsNotFinalized(executor: DatabaseExecutor, locationId: string, businessDate: string) {
  const [finalized] = await executor
    .select({ id: tipDistributions.id })
    .from(tipDistributions)
    .where(
      and(
        eq(tipDistributions.locationId, locationId),
        eq(tipDistributions.businessDate, businessDate),
        eq(tipDistributions.status, "FINALIZED"),
      ),
    )
    .limit(1);

  if (finalized) {
    throw new BusinessRuleError(
      "TIP_DISTRIBUTION_FINALIZED",
      "This check's tips are in a finalized tip distribution. Void that distribution before refunding a tip.",
    );
  }
}

/** RECORDED tender tips on the order's COMPLETED settlement. */
async function recordedTipsOf(executor: DatabaseExecutor, settlementId: string): Promise<string> {
  const [row] = await executor
    .select({ total: sql<string>`COALESCE(SUM(${settlementTenders.tipAmount}), 0)::numeric(14,2)::text` })
    .from(settlementTenders)
    .where(and(eq(settlementTenders.settlementId, settlementId), eq(settlementTenders.status, "RECORDED")));

  return row?.total ?? "0.00";
}

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

/**
 * Records a refund in the caller's transaction (Phase 33: the `record-refund` workflow), with
 * its idempotency key. A retry returns the first outcome, `afterRecorded` included.
 */
export async function recordRefundInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  input: RecordRefundInput,
  afterRecorded?: RefundHook,
): Promise<RefundResult & Record<string, unknown> & { replayed: boolean }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.refund");

  const amount = parseMoney(input.amount, "refund amount");
  const taxAmount = parseMoney(input.taxAmount, "tax part");
  const tipAmount = parseMoney(input.tipAmount ?? "0.00", "tip refund");

  if (amount === "0.00" && tipAmount === "0.00") {
    throw new BusinessRuleError("INVALID_AMOUNT", "Enter a refund or tip amount greater than zero.");
  }

  if (tipAmount !== "0.00" && input.tenderType !== "CASH" && input.tenderType !== "EXTERNAL_CARD") {
    throw new BusinessRuleError("TIP_REFUND_TENDER", "Tips are refunded only in cash or to an external card.");
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

  if (input.tenderType !== "GIFT_CARD" && input.giftCardId) {
    throw new BusinessRuleError("GIFT_CARD_REFUND_NOT_ALLOWED", "Only a gift card refund goes onto a card.");
  }

  if ([input.reason, input.otherDescription, input.externalReference].some(looksLikeCardNumber)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  const orderItemIds = [...new Set(input.orderItemIds ?? [])];
  const { idempotencyKey, ...request } = input;
  const outcome = await runIdempotent<RefundResult & Record<string, number | string>>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: REFUND_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: {
          orderId,
          ...request,
          giftCardId: input.giftCardId ?? null,
          amount,
          taxAmount,
          tipAmount,
          orderItemIds: [...orderItemIds].sort(),
        },
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
          .select({
            status: orderRefunds.status,
            amount: orderRefunds.amount,
            taxAmount: orderRefunds.taxAmount,
            tipAmount: orderRefunds.tipAmount,
          })
          .from(orderRefunds)
          .where(eq(orderRefunds.orderId, order.id));
        const left = assertRefundWithinLimits(
          { totalDue: order.totalDue, taxTotal: order.taxTotal, existing },
          amount,
          taxAmount,
        );
        const remainingTips = assertTipRefundWithinLimits(
          { recordedTips: await recordedTipsOf(transaction, settlement.id), existing },
          tipAmount,
        );

        if (tipAmount !== "0.00") {
          await assertTipsNotFinalized(transaction, order.locationId, order.businessDate);
        }

        // Phase 31 (policy 10, amendment 4): with gift cards on, a GIFT_CARD refund goes back
        // onto a card that paid this check, up to what that card paid less its earlier refunds.
        let giftCard: GiftCardRow | null = null;

        if (input.tenderType === "GIFT_CARD") {
          const program = await readGiftCardProgram(transaction, actor.organizationId);
          const cardTenders = await transaction
            .select({ giftCardId: settlementTenders.giftCardId, status: settlementTenders.status, amount: settlementTenders.amount })
            .from(settlementTenders)
            .where(and(eq(settlementTenders.settlementId, settlement.id), eq(settlementTenders.tenderType, "GIFT_CARD")));
          const ownCardTenders = cardTenders.filter((row) => row.giftCardId !== null);

          if (program.enabled || input.giftCardId) {
            if (!program.enabled || ownCardTenders.length === 0) {
              throw new BusinessRuleError(
                "GIFT_CARD_REFUND_NOT_ALLOWED",
                "No gift card paid this check, so the refund can't go onto one. Refund it the way the guest paid.",
              );
            }

            if (!input.giftCardId) {
              throw new BusinessRuleError("GIFT_CARD_REQUIRED", "Choose the gift card the refund goes back onto.");
            }

            const paid = ownCardTenders.filter((row) => row.giftCardId === input.giftCardId);

            if (paid.length === 0) {
              throw new BusinessRuleError(
                "GIFT_CARD_REFUND_NOT_ALLOWED",
                "That card didn't pay this check. Choose a card that did.",
              );
            }

            const earlier = await transaction
              .select({ status: orderRefunds.status, amount: orderRefunds.amount })
              .from(orderRefunds)
              .where(and(eq(orderRefunds.orderId, order.id), eq(orderRefunds.giftCardId, input.giftCardId)));

            assertCardRefundWithinLimits(paid, earlier, amount);
            giftCard = await lockGiftCard(transaction, actor, input.giftCardId);
            assertCardActive(giftCard);
          }
        }

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
            tipAmount,
            reason: input.reason.trim(),
            otherDescription: input.tenderType === "OTHER" ? input.otherDescription!.trim() : null,
            externalReference: input.externalReference?.trim() || null,
            cashDrawerSessionId,
            giftCardId: giftCard?.id ?? null,
            businessDate: location.businessDate,
            recordedByUserId: actor.userId,
            recordedAt: now,
            idempotencyRecordId,
          })
          .returning();

        if (giftCard) {
          await postGiftCardEntry(transaction, actor, giftCard, { kind: "REFUNDED", amount, refundId: refund!.id }, now);
        }

        if (orderItemIds.length > 0) {
          await transaction
            .insert(orderRefundItems)
            .values(orderItemIds.map((orderItemId) => ({ refundId: refund!.id, orderItemId })));
        }

        const extras = afterRecorded
          ? await afterRecorded(transaction, { id: refund!.id, orderId: order.id, amount, taxAmount }, now)
          : {};

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
            tipAmount,
            businessDate: refund!.businessDate,
            giftNumber: giftCard ? formatGiftCardNumber(giftCard.cardNumber) : null,
            ...extras,
          },
        });

        return {
          ...extras,
          refundId: refund!.id,
          orderId: order.id,
          refundNumber: refund!.refundNumber,
          amount,
          taxAmount,
          tipAmount,
          remaining: left.remaining,
          remainingTax: left.remainingTax,
          remainingTips,
        };
      },
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

/**
 * Voids a refund in the caller's transaction (Phase 33: the `void-refund` workflow).
 * `afterVoided` runs once the refund is VOIDED; its figures go into the audit row and result.
 */
export async function voidRefundInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  refundId: string,
  input: { expectedVersion: number; reason: string },
  afterVoided?: (transaction: DatabaseTransaction, refundId: string, at: Date) => Promise<Record<string, number>>,
): Promise<{ refundId: string; status: string; version: number } & Record<string, number | string>> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.refund-void");

  if (looksLikeCardNumber(input.reason)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  {
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

    // Phase 20: voiding a tip refund changes the tip pool, so not once the date is finalized.
    if (refund!.tipAmount !== "0.00") {
      const [order] = await transaction
        .select({ locationId: orders.locationId, businessDate: orders.businessDate })
        .from(orders)
        .where(eq(orders.id, refund!.orderId));

      await assertTipsNotFinalized(transaction, order!.locationId, order!.businessDate);
    }

    // Voiding cash changes its drawer's count, so the drawer must still be open.
    if (refund!.cashDrawerSessionId) {
      await resolveCashDrawerSession(transaction, actor, refund!.cashDrawerSessionId, true);
    }

    const now = new Date();
    // Phase 31 (policy 10): take the value back off the card, if it still holds it.
    const giftCard = refund!.giftCardId ? await lockGiftCard(transaction, actor, refund!.giftCardId) : null;

    if (giftCard) {
      await postGiftCardEntry(
        transaction,
        actor,
        giftCard,
        { kind: "REFUND_VOIDED", amount: toScale("-" + refund!.amount, 2), refundId },
        now,
      );
    }
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

    const extras = afterVoided ? await afterVoided(transaction, refundId, now) : {};

    await writeOutboxEvents(transaction, [refundEvent(actor, "settlement.refund-voided", refund!, now)]);
    await recordAudit(transaction, actor, {
      action: "settlements.refund-voided",
      entityId: refundId,
      occurredAt: now,
      before: { status: "RECORDED", amount: refund!.amount, tenderType: refund!.tenderType },
      after: {
        status: "VOIDED",
        reason: input.reason.trim(),
        giftNumber: giftCard ? formatGiftCardNumber(giftCard.cardNumber) : null,
        ...extras,
      },
    });

    return { ...extras, refundId, status: updated!.status, version: updated!.version };
  }
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
    tipAmount: row.tipAmount,
    reason: row.reason,
    otherDescription: row.otherDescription,
    externalReference: canSeeReference ? row.externalReference : null,
    giftCardId: row.giftCardId,
    businessDate: row.businessDate,
    recordedAt: row.recordedAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    version: row.version,
  }));
}
