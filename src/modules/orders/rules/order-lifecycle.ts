import { BusinessRuleError } from "@/shared/errors/app-error";

/** Only an OPEN order takes edits, sends, discounts or voids. CLOSED belongs to Phase 11. */
export function assertOrderOpen(status: string): void {
  if (status !== "OPEN") {
    throw new BusinessRuleError(
      "ORDER_NOT_OPEN",
      status === "VOIDED" ? "This order has been voided." : "This order is closed.",
    );
  }
}

/** Drafts are edited and removed; sent items are only voided. */
export function assertItemIsDraft(status: string): void {
  if (status !== "DRAFT") {
    throw new BusinessRuleError(
      "ITEM_ALREADY_SENT",
      status === "VOIDED"
        ? "That item has been voided."
        : "That item has been sent. Void it instead of editing it.",
    );
  }
}

export function assertItemVoidable(status: string): void {
  if (status === "VOIDED") {
    throw new BusinessRuleError("ITEM_ALREADY_VOIDED", "That item has already been voided.");
  }

  if (status !== "SUBMITTED") {
    throw new BusinessRuleError(
      "ITEM_NOT_SENT",
      "That item hasn't been sent. Remove the draft instead of voiding it.",
    );
  }
}

/** The kitchen-facing text: modifier preparation instructions, then the free text. */
export function buildKitchenInstructions(
  modifierInstructions: readonly (string | null)[],
  specialInstructions: string | null,
): string | null {
  const parts = [
    ...modifierInstructions.filter((entry): entry is string => Boolean(entry && entry.trim())),
    ...(specialInstructions?.trim() ? [specialInstructions.trim()] : []),
  ];

  return parts.length === 0 ? null : parts.join("; ");
}
