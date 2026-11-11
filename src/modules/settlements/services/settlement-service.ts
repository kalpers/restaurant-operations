import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { settlements, settlementTenders } from "@/db/schema";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrderRow, readOrderLocation, type OrderRow } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import {
  appendSettlementHistory,
  findOpenSettlementForOrder,
  findSettlement,
  listTenders,
  lockSettlement,
  refreshSettlementTotals,
  type SettlementRow,
} from "../repositories/settlement-repository";
import { assertSettlementOpen, planTender, reconcile } from "../rules/settlement-math";
import { TENDER_PERMISSIONS, TENDER_SCOPE, type TenderType } from "../types";
import { assertPermission } from "./access";
import { resolveCashDrawerSession } from "./drawer-service";

// Settlement commands (README section 19). Record only: nothing here contacts a payment
// provider. Every command locks the order row first, then the settlement, the same order
// SEND, voids and discounts use, so they serialize and can't deadlock. While a settlement
// is OPEN the order's amount is locked by a database trigger.

export function settlementEvent(
  actor: Actor,
  eventType: string,
  settlement: { id: string; orderId: string },
  at: Date,
  extra: Record<string, string | number | null> = {},
) {
  return {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    eventType,
    aggregateType: "settlement",
    aggregateId: settlement.id,
    payload: { settlementId: settlement.id, orderId: settlement.orderId, ...extra },
    occurredAt: at,
  };
}

/** Locks the settlement's order, then the settlement, and checks the client's version. */
export async function lockSettlementWithOrder(
  transaction: DatabaseTransaction,
  actor: Actor,
  settlementId: string,
  expectedVersion: number | null,
): Promise<{ order: OrderRow; settlement: SettlementRow }> {
  const found = await findSettlement(transaction, actor, settlementId);

  if (!found) {
    throw new NotFoundError("settlement");
  }

  const order = await lockOrderRow(transaction, actor, found.orderId);
  const settlement = await lockSettlement(transaction, actor, settlementId, expectedVersion);

  return { order, settlement };
}

export type OpenSettlementResult = {
  settlementId: string;
  settlementVersion: number;
  orderAmountSnapshot: string;
  existing: boolean;
};

/**
 * Opens a settlement for an OPEN order, snapshotting its post-discount, pre-tax amount. An
 * order has at most one OPEN settlement (partial unique index); asking again returns it.
 * Draft items may still exist now, but completion will need none.
 */
export async function openSettlement(
  database: Database,
  actor: Actor,
  orderId: string,
): Promise<OpenSettlementResult> {
  assertPermission(actor, "settlements.create");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrderRow(transaction, actor, orderId);

    assertOrderOpen(order.status);

    const existing = await findOpenSettlementForOrder(transaction, order.id);

    if (existing) {
      return {
        settlementId: existing.id,
        settlementVersion: existing.version,
        orderAmountSnapshot: existing.orderAmountSnapshot,
        existing: true,
      };
    }

    const now = new Date();
    const location = await readOrderLocation(transaction, actor.locationId, now);
    const [created] = await transaction
      .insert(settlements)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        orderId: order.id,
        // Phase 17: the amount due includes tax; the tax part is kept alongside it.
        orderAmountSnapshot: order.totalDue,
        taxTotalSnapshot: order.taxTotal,
        openedByUserId: actor.userId,
        openedAt: now,
        openedBusinessDate: location.businessDate,
      })
      .returning()
      .catch((error: unknown) => {
        // The order lock makes this unreachable; the index is the final guard.
        if (isUniqueViolation(error)) {
          throw new ConflictError("SETTLEMENT_ALREADY_OPEN", "This order already has an open settlement.");
        }

        throw error;
      });

    await appendSettlementHistory(transaction, {
      settlementId: created!.id,
      status: "OPEN",
      reason: null,
      userId: actor.userId,
      at: now,
    });
    await writeOutboxEvents(transaction, [settlementEvent(actor, "settlement.opened", created!, now)]);
    await recordAudit(transaction, actor, {
      action: "settlements.opened",
      entityId: created!.id,
      occurredAt: now,
      after: { orderId: created!.orderId, status: "OPEN", amountDue: created!.orderAmountSnapshot },
    });

    return {
      settlementId: created!.id,
      settlementVersion: created!.version,
      orderAmountSnapshot: created!.orderAmountSnapshot,
      existing: false,
    };
  });
}

export type RecordTenderInput = {
  expectedVersion: number;
  idempotencyKey: string;
  tenderType: TenderType;
  outcome: "RECORDED" | "FAILED";
  amount: string;
  tipAmount: string | null;
  receivedAmount: string | null;
  externalReference: string | null;
  providerName: string | null;
  cardBrand: string | null;
  cardLastFour: string | null;
  authorizationReference: string | null;
  otherDescription: string | null;
  failureReason: string | null;
  /** Phase 17: the OPEN drawer session cash goes into. CASH only. */
  cashDrawerSessionId?: string | null;
};

export type RecordTenderResult = {
  settlementId: string;
  tenderId: string;
  tenderStatus: string;
  amount: string;
  tipAmount: string;
  changeAmount: string;
  remainingAmount: string;
  settlementVersion: number;
};

const CARD_ONLY_FIELDS = ["providerName", "cardBrand", "cardLastFour", "authorizationReference"] as const;

/**
 * Records one tender. Retrying with the same idempotency key returns the first result and
 * records nothing more. The amount is checked against what remains under the locks, so two
 * terminals can't both take the last of the balance.
 */
export async function recordTender(
  database: Database,
  actor: Actor,
  settlementId: string,
  input: RecordTenderInput,
): Promise<RecordTenderResult & { replayed: boolean }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, TENDER_PERMISSIONS[input.tenderType]);

  if (input.tenderType !== "EXTERNAL_CARD" && CARD_ONLY_FIELDS.some((field) => input[field])) {
    throw new BusinessRuleError("CARD_FIELDS_NOT_ALLOWED", "Card details apply to external card tenders only.");
  }

  if (input.tenderType === "CASH" && input.externalReference) {
    throw new BusinessRuleError("REFERENCE_NOT_ALLOWED", "Cash has no external reference.");
  }

  if (input.tenderType !== "CASH" && input.cashDrawerSessionId) {
    throw new BusinessRuleError("DRAWER_CASH_ONLY", "Only cash goes into a drawer.");
  }

  const { idempotencyKey, ...request } = input;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<RecordTenderResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: TENDER_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: { settlementId, ...request },
      },
      async (idempotencyRecordId) => {
        const { order, settlement } = await lockSettlementWithOrder(
          transaction,
          actor,
          settlementId,
          input.expectedVersion,
        );

        assertSettlementOpen(settlement.status);
        assertOrderOpen(order.status);

        const current = reconcile(settlement.orderAmountSnapshot, await listTenders(transaction, settlement.id));
        const planned = planTender(
          {
            tenderType: input.tenderType,
            outcome: input.outcome,
            amount: input.amount,
            tipAmount: input.tipAmount,
            receivedAmount: input.receivedAmount,
            otherDescription: input.otherDescription,
            failureReason: input.failureReason,
            textFields: [input.externalReference, input.providerName, input.cardBrand, input.authorizationReference],
          },
          current.remainingAmount,
        );
        const now = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, now);
        // Phase 17: cash goes into an open drawer session, required per the Location setting.
        const cashDrawerSessionId =
          input.tenderType === "CASH"
            ? await resolveCashDrawerSession(
                transaction,
                actor,
                input.cashDrawerSessionId ?? null,
                location.cashDrawerRequired,
              )
            : null;
        const [tender] = await transaction
          .insert(settlementTenders)
          .values({
            settlementId: settlement.id,
            tenderType: input.tenderType,
            status: planned.status,
            amount: planned.amount,
            tipAmount: planned.tipAmount,
            receivedAmount: planned.receivedAmount,
            changeAmount: planned.changeAmount,
            externalReference: input.externalReference,
            providerName: input.providerName,
            cardBrand: input.cardBrand,
            cardLastFour: input.cardLastFour,
            authorizationReference: input.authorizationReference,
            otherDescription: input.tenderType === "OTHER" ? input.otherDescription : null,
            failureReason: planned.status === "FAILED" ? input.failureReason : null,
            recordedByUserId: actor.userId,
            recordedAt: now,
            businessDate: location.businessDate,
            idempotencyRecordId,
            cashDrawerSessionId,
          })
          .returning();
        const updated = await refreshSettlementTotals(transaction, settlement, { updatedAt: now });
        const after = reconcile(updated.orderAmountSnapshot, await listTenders(transaction, settlement.id));

        await writeOutboxEvents(transaction, [
          settlementEvent(actor, "settlement.tender-recorded", settlement, now, { tenderId: tender!.id }),
        ]);
        // Card and provider details on the tender are not copied into the audit trail.
        await recordAudit(transaction, actor, {
          action: "settlements.tender-recorded",
          entityId: settlement.id,
          occurredAt: now,
          after: {
            tenderId: tender!.id,
            tenderType: tender!.tenderType,
            status: tender!.status,
            amount: tender!.amount,
            tipAmount: tender!.tipAmount,
            cashReceived: tender!.receivedAmount,
            changeGiven: tender!.changeAmount,
            description: tender!.otherDescription,
          },
        });

        return {
          settlementId: settlement.id,
          tenderId: tender!.id,
          tenderStatus: tender!.status,
          amount: tender!.amount,
          tipAmount: tender!.tipAmount,
          changeAmount: tender!.changeAmount,
          remainingAmount: after.remainingAmount,
          settlementVersion: updated.version,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

/**
 * Voids a RECORDED tender while its settlement is OPEN. For an externally handled tender
 * this corrects the application record only; it reverses nothing outside the application.
 */
export async function voidTender(
  database: Database,
  actor: Actor,
  settlementId: string,
  tenderId: string,
  input: { expectedVersion: number; reason: string },
): Promise<{ settlementId: string; tenderId: string; settlementVersion: number; remainingAmount: string }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.void-tender");

  return withTransaction(database, async (transaction) => {
    const { order, settlement } = await lockSettlementWithOrder(
      transaction,
      actor,
      settlementId,
      input.expectedVersion,
    );

    assertSettlementOpen(settlement.status);
    assertOrderOpen(order.status);

    const tender = (await listTenders(transaction, settlement.id)).find((row) => row.id === tenderId);

    if (!tender) {
      throw new NotFoundError("tender");
    }

    if (tender.status !== "RECORDED") {
      throw new BusinessRuleError(
        "TENDER_NOT_VOIDABLE",
        tender.status === "VOIDED" ? "That tender is already voided." : "A failed attempt can't be voided.",
      );
    }

    // Phase 17: voiding cash changes its drawer's count, so the drawer must still be open.
    if (tender.cashDrawerSessionId) {
      await resolveCashDrawerSession(transaction, actor, tender.cashDrawerSessionId, true);
    }

    const now = new Date();

    await transaction
      .update(settlementTenders)
      .set({ status: "VOIDED", voidedAt: now, voidedByUserId: actor.userId, voidReason: input.reason })
      .where(eq(settlementTenders.id, tender.id));

    const updated = await refreshSettlementTotals(transaction, settlement, { updatedAt: now });

    await writeOutboxEvents(transaction, [
      settlementEvent(actor, "settlement.tender-voided", settlement, now, { tenderId: tender.id }),
    ]);
    await recordAudit(transaction, actor, {
      action: "settlements.tender-voided",
      entityId: settlement.id,
      occurredAt: now,
      before: { tenderId: tender.id, tenderType: tender.tenderType, amount: tender.amount, status: tender.status },
      after: { tenderId: tender.id, status: "VOIDED", reason: input.reason },
    });

    return {
      settlementId: settlement.id,
      tenderId: tender.id,
      settlementVersion: updated.version,
      remainingAmount: reconcile(updated.orderAmountSnapshot, await listTenders(transaction, settlement.id))
        .remainingAmount,
    };
  });
}

/**
 * Cancels an OPEN settlement that has no RECORDED tender left (void them first), which
 * unlocks the order so its check can change. It stays as history.
 */
export async function cancelSettlement(
  database: Database,
  actor: Actor,
  settlementId: string,
  input: { expectedVersion: number; reason: string },
): Promise<{ settlementId: string; status: "CANCELLED" }> {
  assertPermission(actor, "settlements.view");
  assertPermission(actor, "settlements.create");

  return withTransaction(database, async (transaction) => {
    const { settlement } = await lockSettlementWithOrder(transaction, actor, settlementId, input.expectedVersion);

    assertSettlementOpen(settlement.status);

    const tenders = await listTenders(transaction, settlement.id);

    if (tenders.some((tender) => tender.status === "RECORDED")) {
      throw new BusinessRuleError(
        "TENDERS_RECORDED",
        "Void the recorded tenders before cancelling this settlement.",
      );
    }

    const now = new Date();

    await refreshSettlementTotals(transaction, settlement, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
      updatedAt: now,
    });
    await appendSettlementHistory(transaction, {
      settlementId: settlement.id,
      status: "CANCELLED",
      reason: input.reason,
      userId: actor.userId,
      at: now,
    });
    await writeOutboxEvents(transaction, [settlementEvent(actor, "settlement.cancelled", settlement, now)]);
    await recordAudit(transaction, actor, {
      action: "settlements.cancelled",
      entityId: settlement.id,
      occurredAt: now,
      before: { status: settlement.status },
      after: { orderId: settlement.orderId, status: "CANCELLED", reason: input.reason },
    });

    return { settlementId: settlement.id, status: "CANCELLED" };
  });
}
