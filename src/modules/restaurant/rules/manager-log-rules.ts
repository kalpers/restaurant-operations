import { BusinessRuleError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

// Phase 32 manager log rules (policies 3–6). Pure, so they are unit-tested on their own.

export type LogDateChoice = "CURRENT" | "PREVIOUS";

/** The longest range a log search may cover (policy 10). */
export const MAX_LOG_SEARCH_DAYS = 31;

/**
 * Policy 4: an entry is for the location's current business date, or by choice the previous
 * one, which covers a closing manager writing after the cutoff. Nothing earlier.
 */
export function entryBusinessDate(choice: LogDateChoice, currentBusinessDate: string): string {
  return choice === "PREVIOUS" ? addDays(currentBusinessDate, -1) : currentBusinessDate;
}

/** Policy 3: the human-readable entry number. */
export function formatLogNumber(entryNumber: number): string {
  return `LOG-${String(entryNumber).padStart(6, "0")}`;
}

/** Inclusive day count of a `from`–`to` range of dates. */
export function daysInRange(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);

  return Math.round((end - start) / 86_400_000) + 1;
}

/** A search covers at least one day and at most 31 (policy 10). */
export function assertSearchRange(from: string, to: string, maxDays = MAX_LOG_SEARCH_DAYS): void {
  const days = daysInRange(from, to);

  if (days < 1) {
    throw new BusinessRuleError("INVALID_RANGE", "The end date must be on or after the start date.");
  }

  if (days > maxDays) {
    throw new BusinessRuleError("RANGE_TOO_LONG", `Search up to ${maxDays} days at a time.`);
  }
}

/** A text search pattern for ILIKE, with the wildcard characters taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** 13 or more digits in a row could be a card number, which is never stored (rule 15). */
export function assertNoCardNumber(...texts: (string | null | undefined)[]): void {
  if (texts.some((text) => /[0-9]{13,}/.test(text ?? ""))) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't write card numbers here.");
  }
}

/** Policy 6: a redaction reason is required, up to 500 characters. */
export function redactionReason(reason: string): string {
  const trimmed = reason.trim();

  if (!trimmed || trimmed.length > 500) {
    throw new BusinessRuleError("REASON_REQUIRED", "Give a reason of up to 500 characters.");
  }

  return trimmed;
}
