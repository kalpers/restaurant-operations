import {
  addDecimals,
  compareDecimals,
  isPositiveDecimal,
  subtractDecimals,
  sumDecimals,
} from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import type { PurchaseOrderStatus } from "../types";
import { extendCost } from "./costing";

/** A line's total: quantity times unit price, half-up to four places. */
export function lineTotal(orderedQuantity: string, unitPrice: string): string {
  return extendCost(orderedQuantity, unitPrice);
}

/** A PO total is the exact sum of its line totals. No tax or freight. */
export function orderTotal(lineTotals: readonly string[]): string {
  return sumDecimals(lineTotals, 4);
}

export function remainingQuantity(ordered: string, receivedSoFar: string): string {
  return subtractDecimals(ordered, receivedSoFar);
}

/** Approved policy: no over-receiving, and no override. */
export function assertReceivable(input: {
  ordered: string;
  receivedSoFar: string;
  receiving: string;
}): void {
  if (!isPositiveDecimal(input.receiving)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "Received quantities must be positive.");
  }

  const after = addDecimals(input.receivedSoFar, input.receiving);

  if (compareDecimals(after, input.ordered) > 0) {
    throw new BusinessRuleError(
      "OVER_RECEIPT",
      "That is more than is still on order for this line. Over-receiving isn't allowed.",
    );
  }
}

/** Status once the lines' cumulative receipts are known. */
export function statusAfterReceipt(
  lines: readonly { ordered: string; received: string }[],
): PurchaseOrderStatus {
  const complete = lines.every((line) => compareDecimals(line.received, line.ordered) >= 0);

  return complete ? "RECEIVED" : "PARTIALLY_RECEIVED";
}

const TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIALLY_RECEIVED: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

export function assertTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new BusinessRuleError(
      "INVALID_PO_TRANSITION",
      `A ${from.toLowerCase().replace("_", " ")} purchase order can't become ${to.toLowerCase().replace("_", " ")}.`,
    );
  }
}

export function canReceive(status: PurchaseOrderStatus): boolean {
  return status === "SUBMITTED" || status === "PARTIALLY_RECEIVED";
}

export function formatPoNumber(sequence: number): string {
  return `PO-${String(sequence).padStart(6, "0")}`;
}
