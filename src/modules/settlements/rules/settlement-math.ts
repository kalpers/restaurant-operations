import { BusinessRuleError } from "@/shared/errors/app-error";
import {
  compareDecimals,
  isDecimalString,
  significantScale,
  subtractDecimals,
  sumDecimals,
  toScale,
} from "@/shared/decimal/decimal";

import { TIPPABLE_TENDER_TYPES, type TenderStatus, type TenderType } from "../types";

// Exact settlement arithmetic (README section 19). Every amount is a decimal string in
// cents and every sum uses the shared BigInt decimal helpers: never a JavaScript number.
// Tax is deliberately not calculated: the obligation is the Order's post-discount,
// pre-tax amount. Tips are separate from it, and cash change is never tender value.

const MONEY_SCALE = 2;
const ZERO = "0.00";

/** A nonnegative money amount with at most two decimal places, normalized to cents. */
export function parseMoney(value: string, field: string): string {
  if (!isDecimalString(value) || value.startsWith("-")) {
    throw new BusinessRuleError("INVALID_AMOUNT", `The ${field} must be a positive amount.`);
  }

  if (significantScale(value) > MONEY_SCALE) {
    throw new BusinessRuleError("INVALID_AMOUNT", `The ${field} can't have fractions of a cent.`);
  }

  const normalized = toScale(value, MONEY_SCALE);

  if (compareDecimals(normalized, "9999999999.99") > 0) {
    throw new BusinessRuleError("INVALID_AMOUNT", `The ${field} is too large.`);
  }

  return normalized;
}

/** 13 or more consecutive digits looks like a card number. Never accepted or stored. */
export function looksLikeCardNumber(text: string | null | undefined): boolean {
  return typeof text === "string" && /\d{13,}/.test(text.replace(/[\s-]/g, ""));
}

export type TenderFacts = { status: TenderStatus | string; amount: string; tipAmount: string; changeAmount: string };

export type Reconciliation = {
  /** Sum of RECORDED amounts applied to the Order. */
  tenderedAmount: string;
  tipAmount: string;
  changeDue: string;
  /** Order obligation still unsatisfied. Never negative. */
  remainingAmount: string;
};

/** Only RECORDED tenders count. VOIDED and FAILED contribute zero. */
export function reconcile(orderAmountSnapshot: string, tenders: readonly TenderFacts[]): Reconciliation {
  const recorded = tenders.filter((tender) => tender.status === "RECORDED");
  const tenderedAmount = sumDecimals(
    recorded.map((tender) => tender.amount),
    MONEY_SCALE,
  );
  const remainingAmount = toScale(subtractDecimals(orderAmountSnapshot, tenderedAmount), MONEY_SCALE);

  if (compareDecimals(remainingAmount, ZERO) < 0) {
    // The service and a check constraint prevent this; refuse rather than report a credit.
    throw new BusinessRuleError("OVER_SETTLED", "The tenders exceed the order amount.");
  }

  return {
    tenderedAmount,
    tipAmount: sumDecimals(
      recorded.map((tender) => tender.tipAmount),
      MONEY_SCALE,
    ),
    changeDue: sumDecimals(
      recorded.map((tender) => tender.changeAmount),
      MONEY_SCALE,
    ),
    remainingAmount,
  };
}

export type TenderRequest = {
  tenderType: TenderType;
  /** RECORDED, or FAILED for an externally reported card failure. */
  outcome: "RECORDED" | "FAILED";
  amount: string;
  tipAmount?: string | null;
  receivedAmount?: string | null;
  otherDescription?: string | null;
  failureReason?: string | null;
  textFields?: readonly (string | null | undefined)[];
};

export type PlannedTender = {
  status: "RECORDED" | "FAILED";
  amount: string;
  tipAmount: string;
  receivedAmount: string | null;
  changeAmount: string;
};

/**
 * Validates one tender against what remains and works out its exact values.
 *
 * - The amount applied is positive and never more than what remains (no over-settlement).
 * - A tip is allowed only on CASH and EXTERNAL_CARD.
 * - CASH: received must cover amount + tip; change = received - amount - tip (no rounding).
 * - FAILED is only an externally reported EXTERNAL_CARD failure, with a reason and no tip.
 * - OTHER needs a description. No text field may look like a card number.
 */
export function planTender(request: TenderRequest, remainingAmount: string): PlannedTender {
  const amount = parseMoney(request.amount, "amount");
  const tipAmount = parseMoney(request.tipAmount?.trim() || ZERO, "tip");

  if (compareDecimals(amount, ZERO) <= 0) {
    throw new BusinessRuleError("INVALID_AMOUNT", "The amount must be more than zero.");
  }

  if ([...(request.textFields ?? []), request.otherDescription, request.failureReason].some(looksLikeCardNumber)) {
    throw new BusinessRuleError(
      "CARD_DATA_REFUSED",
      "Don't enter card numbers. Record only the last four digits and a reference.",
    );
  }

  if (compareDecimals(tipAmount, ZERO) > 0 && !TIPPABLE_TENDER_TYPES.includes(request.tenderType)) {
    throw new BusinessRuleError("TIP_NOT_ALLOWED", "Tips can be recorded only on cash or card.");
  }

  if (request.tenderType === "OTHER" && !request.otherDescription?.trim()) {
    throw new BusinessRuleError("DESCRIPTION_REQUIRED", "Describe what an OTHER tender was.");
  }

  if (request.outcome === "FAILED") {
    if (request.tenderType !== "EXTERNAL_CARD") {
      throw new BusinessRuleError("FAILURE_NOT_ALLOWED", "Only an external card attempt can be recorded as failed.");
    }

    if (!request.failureReason?.trim()) {
      throw new BusinessRuleError("FAILURE_REASON_REQUIRED", "Say why the card attempt failed.");
    }

    if (compareDecimals(tipAmount, ZERO) > 0) {
      throw new BusinessRuleError("TIP_NOT_ALLOWED", "A failed attempt has no tip.");
    }

    // A failure contributes nothing, so it isn't limited by what remains.
    return { status: "FAILED", amount, tipAmount: ZERO, receivedAmount: null, changeAmount: ZERO };
  }

  if (compareDecimals(amount, remainingAmount) > 0) {
    throw new BusinessRuleError(
      "AMOUNT_EXCEEDS_REMAINING",
      `Only ${remainingAmount} remains on this order. Record cash over that as change.`,
      { remainingAmount },
    );
  }

  if (request.tenderType !== "CASH") {
    if (request.receivedAmount) {
      throw new BusinessRuleError("RECEIVED_NOT_ALLOWED", "Cash received applies to cash only.");
    }

    return { status: "RECORDED", amount, tipAmount, receivedAmount: null, changeAmount: ZERO };
  }

  if (!request.receivedAmount?.trim()) {
    throw new BusinessRuleError("RECEIVED_REQUIRED", "Enter the cash received.");
  }

  const receivedAmount = parseMoney(request.receivedAmount, "cash received");
  const changeAmount = toScale(subtractDecimals(subtractDecimals(receivedAmount, amount), tipAmount), MONEY_SCALE);

  if (compareDecimals(changeAmount, ZERO) < 0) {
    throw new BusinessRuleError(
      "INSUFFICIENT_CASH",
      "The cash received doesn't cover the amount applied and the tip.",
    );
  }

  return { status: "RECORDED", amount, tipAmount, receivedAmount, changeAmount };
}

/** Exact completion: nothing remains and no draft item is left unsent. */
export function assertCanComplete(
  orderAmountSnapshot: string,
  tenders: readonly TenderFacts[],
  draftItemCount: number,
): Reconciliation {
  if (draftItemCount > 0) {
    throw new BusinessRuleError(
      "DRAFT_ITEMS_PRESENT",
      "Send or remove the unsent items before completing the settlement.",
    );
  }

  const result = reconcile(orderAmountSnapshot, tenders);

  if (compareDecimals(result.remainingAmount, ZERO) !== 0) {
    throw new BusinessRuleError(
      "SETTLEMENT_NOT_BALANCED",
      `${result.remainingAmount} still remains on this order.`,
      { remainingAmount: result.remainingAmount },
    );
  }

  return result;
}

export function assertSettlementOpen(status: string): void {
  if (status !== "OPEN") {
    throw new BusinessRuleError(
      "SETTLEMENT_NOT_OPEN",
      status === "COMPLETED" ? "This settlement is complete." : "This settlement was cancelled.",
    );
  }
}

/** Cash a guest would get back for a given amount, tip and cash received; a UI preview. */
export function previewChange(amount: string, tipAmount: string, receivedAmount: string): string | null {
  try {
    const change = toScale(
      subtractDecimals(subtractDecimals(parseMoney(receivedAmount, "cash"), parseMoney(amount, "amount")), parseMoney(tipAmount || ZERO, "tip")),
      MONEY_SCALE,
    );

    return compareDecimals(change, ZERO) < 0 ? null : change;
  } catch {
    return null;
  }
}
