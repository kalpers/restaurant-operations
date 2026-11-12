import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";

import { lockOrder, recomputeAndBumpOrder } from "../repositories/order-repository";
import { assertOrderOpen } from "../rules/order-lifecycle";
import { assertPermission } from "./access";

// Phase 20 (policy 16, D15): a tax-exempt check pays no tax. It is set and cleared only on
// an OPEN order with no OPEN settlement (the order guard trigger refuses the change while
// one is open, as for any amount change), under `tax.exempt`, with a reason and an optional
// certificate reference. Totals and tax lines are recomputed in the same transaction.

const MAX_REASON = 200;
const MAX_REFERENCE = 60;
/** The Phase 17 card-safety rule: no run of 13 or more digits. */
const LONG_DIGIT_RUN = /\d{13,}/;

function cleanText(value: string | null | undefined, max: number, label: string): string | null {
  const trimmed = value?.trim() ?? "";

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > max) {
    throw new ValidationError(`${label} must be at most ${max} characters.`);
  }

  if (LONG_DIGIT_RUN.test(trimmed)) {
    throw new BusinessRuleError(
      "SENSITIVE_DATA_REFUSED",
      `${label} can't contain a long run of digits. Record only a certificate reference.`,
    );
  }

  return trimmed;
}

export async function setTaxExemption(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { reason: string; reference?: string | null; expectedVersion: number },
) {
  assertPermission(actor, "tax.exempt");

  const reason = cleanText(input.reason, MAX_REASON, "The reason");
  const reference = cleanText(input.reference, MAX_REFERENCE, "The certificate reference");

  if (!reason) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason for the exemption.");
  }

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    if (order.taxExempt) {
      throw new BusinessRuleError("ALREADY_TAX_EXEMPT", "This check is already tax exempt.");
    }

    const updated = await recomputeAndBumpOrder(transaction, orderId, {
      taxExempt: true,
      taxExemptReason: reason,
      taxExemptReference: reference,
      taxExemptByUserId: actor.userId,
      taxExemptAt: new Date(),
    });

    await recordAudit(transaction, actor, {
      action: "tax.exemption-set",
      entityId: orderId,
      before: { taxTotal: order.taxTotal },
      after: { taxTotal: updated.taxTotal, totalDue: updated.totalDue },
      details: { orderNumber: order.orderNumber, reason, hasReference: reference !== null },
    });

    return { orderVersion: updated.version, taxTotal: updated.taxTotal, totalDue: updated.totalDue };
  });
}

export async function clearTaxExemption(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "tax.exempt");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    if (!order.taxExempt) {
      throw new BusinessRuleError("NOT_TAX_EXEMPT", "This check isn't tax exempt.");
    }

    const updated = await recomputeAndBumpOrder(transaction, orderId, {
      taxExempt: false,
      taxExemptReason: null,
      taxExemptReference: null,
      taxExemptByUserId: null,
      taxExemptAt: null,
    });

    await recordAudit(transaction, actor, {
      action: "tax.exemption-cleared",
      entityId: orderId,
      before: { taxTotal: order.taxTotal },
      after: { taxTotal: updated.taxTotal, totalDue: updated.totalDue },
      details: { orderNumber: order.orderNumber },
    });

    return { orderVersion: updated.version, taxTotal: updated.taxTotal, totalDue: updated.totalDue };
  });
}
