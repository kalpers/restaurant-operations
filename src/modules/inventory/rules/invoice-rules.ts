import type { SupplierInvoiceStatus } from "@/db/schema/supplier-invoices";
import {
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  negateDecimal,
  roundHalfUp,
  subtractDecimals,
  sumDecimals,
  toScale,
} from "@/shared/decimal/decimal";
import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";

// Phase 36 part 4 (policy 8): supplier invoice rules. Pure, so they are unit-tested on their
// own. Money is cents (scale 2); unit prices and quantities are scale 4, as on receipts.

/** Policy 8: the human-readable invoice number, per location. */
export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(6, "0")}`;
}

/** `a × b`, rounded half up to `scale` places. */
const times = (a: string, b: string, scale: number) => roundHalfUp(multiplyExact(a, b), scale);

/** An item line's amount: quantity × unit price, to the cent. */
export function itemLineAmount(quantity: string, unitPrice: string): string {
  return times(quantity, unitPrice, 2);
}

/** A charge line's amount: a credit is stored negative, everything else zero or more. */
export function chargeLineAmount(kind: "FREIGHT" | "TAX" | "OTHER" | "CREDIT", amount: string): string {
  const value = toScale(amount, 2);

  if (compareDecimals(value, "0") < 0) {
    throw new BusinessRuleError("INVOICE_AMOUNT_INVALID", "Enter amounts as positive numbers; a credit is taken off for you.");
  }

  return kind === "CREDIT" ? negateDecimal(value) : value;
}

/** Policy 8: the lines must add up to the supplier's stated total before approval. */
export function linesTotal(amounts: readonly string[]): string {
  return sumDecimals(amounts, 2);
}

export function assertTotalsMatch(amounts: readonly string[], statedTotal: string): void {
  const total = linesTotal(amounts);

  if (compareDecimals(total, statedTotal) !== 0) {
    throw new BusinessRuleError(
      "INVOICE_TOTAL_MISMATCH",
      `The lines come to ${total}, but the invoice says ${toScale(statedTotal, 2)}. Fix the lines before approving.`,
    );
  }
}

export type Tolerance = { percent: string; amount: string };

export type LineFacts = {
  receivedQuantity: string;
  invoicedQuantity: string;
  receiptUnitCost: string;
  orderedUnitPrice: string;
  invoicedUnitPrice: string;
  amount: string;
};

export type LineVariance = {
  quantityVariance: string;
  priceVariance: string;
  amountVariance: string;
  /** Null when the receipt cost is zero. */
  pricePercent: string | null;
  priceWithinTolerance: boolean;
  quantityMatches: boolean;
  /** Both: nothing on this line needs a reason to approve. */
  withinTolerance: boolean;
};

const abs = (value: string) => (compareDecimals(value, "0") < 0 ? negateDecimal(value) : value);

/**
 * Policy 8: one item line against what was received. A price is in tolerance when the per-unit
 * difference from the receipt's cost is no more than the larger of the amount and the percent
 * of that cost. Quantity has no tolerance.
 */
export function lineVariance(line: LineFacts, tolerance: Tolerance): LineVariance {
  const quantityVariance = toScale(subtractDecimals(line.invoicedQuantity, line.receivedQuantity), 4);
  const priceVariance = toScale(subtractDecimals(line.invoicedUnitPrice, line.receiptUnitCost), 4);
  const receivedValue = times(line.receivedQuantity, line.receiptUnitCost, 2);
  const amountVariance = toScale(subtractDecimals(line.amount, receivedValue), 2);
  const pricePercent =
    compareDecimals(line.receiptUnitCost, "0") === 0 ? null : divideRoundHalfUp(multiplyExact(priceVariance, "100"), line.receiptUnitCost, 2);
  const byPercent = times(line.receiptUnitCost, divideRoundHalfUp(tolerance.percent, "100", 6), 4);
  const allowed = compareDecimals(byPercent, tolerance.amount) > 0 ? byPercent : toScale(tolerance.amount, 4);
  const priceWithinTolerance = compareDecimals(abs(priceVariance), allowed) <= 0;
  const quantityMatches = compareDecimals(quantityVariance, "0") === 0;

  return {
    quantityVariance,
    priceVariance,
    amountVariance,
    pricePercent,
    priceWithinTolerance,
    quantityMatches,
    withinTolerance: priceWithinTolerance && quantityMatches,
  };
}

/** Lines are edited while an invoice is a draft or disputed. */
export function assertInvoiceEditable(status: SupplierInvoiceStatus): void {
  if (status !== "DRAFT" && status !== "DISPUTED") {
    throw new BusinessRuleError("INVOICE_NOT_EDITABLE", "Only a draft or disputed invoice can be changed.");
  }
}

/** Policy 8: the status moves. Voiding an approved invoice is for approvers too. */
const MOVES: Record<SupplierInvoiceStatus, readonly SupplierInvoiceStatus[]> = {
  DRAFT: ["DISPUTED", "APPROVED", "VOIDED"],
  DISPUTED: ["APPROVED", "VOIDED"],
  APPROVED: ["VOIDED"],
  VOIDED: [],
};

export function assertInvoiceTransition(from: SupplierInvoiceStatus, to: SupplierInvoiceStatus): void {
  if (!MOVES[from].includes(to)) {
    throw new BusinessRuleError("INVOICE_STATUS_INVALID", `An invoice can't go from ${from.toLowerCase()} to ${to.toLowerCase()}.`);
  }
}

/** A reason of 1 to 500 characters. */
export function reasonText(reason: string | null | undefined, code: string, message: string): string {
  const trimmed = (reason ?? "").trim();

  if (!trimmed || trimmed.length > 500) {
    throw new BusinessRuleError(code, message);
  }

  return trimmed;
}

/** The supplier's document number: letters, digits, "-" and "/", up to 40 (policy 8: no card-digit rule). */
export function supplierDocumentNumber(raw: string): string {
  const trimmed = raw.trim();

  if (!/^[A-Za-z0-9/-]{1,40}$/.test(trimmed)) {
    throw new BusinessRuleError("INVOICE_NUMBER_INVALID", "Use the supplier's invoice number: letters, digits, - and /, up to 40.");
  }

  return trimmed;
}

/** 13 or more digits in a row could be a card number, which is never stored (rule 15). */
export function assertNoCardDigits(...texts: (string | null | undefined)[]): void {
  if (texts.some((text) => /[0-9]{13,}/.test(text ?? ""))) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't write card numbers here.");
  }
}

const SIGNATURES: Record<string, readonly number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

/** Policy 8: a scanned copy is a PDF, PNG or JPEG of at most `maxBytes`, and its bytes say so. */
export function assertInvoiceFileAcceptable(input: { bytes: Uint8Array; mimeType: string; maxBytes: number }): string {
  const mimeType = input.mimeType.split(";")[0]!.trim().toLowerCase();
  const signature = SIGNATURES[mimeType];

  if (input.bytes.length === 0) {
    throw new ValidationError("The file is empty.");
  }

  if (input.bytes.length > input.maxBytes) {
    throw new ValidationError("The file is too large.");
  }

  if (!signature) {
    throw new ValidationError("Upload a PDF, PNG or JPEG.");
  }

  if (!signature.every((value, index) => input.bytes[index] === value)) {
    throw new ValidationError("The file's contents don't match its type.");
  }

  return mimeType;
}
