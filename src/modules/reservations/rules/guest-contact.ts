import { normalizeEmail } from "@/modules/auth/email";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 21 (policy 1): how a guest's phone and email are matched. Lookups use these forms;
// the profile keeps what was typed for display.

/** Digits only, with a leading "+" kept. Null when there is nothing to keep. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  if (trimmed === "") {
    return null;
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 3 || digits.length > 15) {
    throw new BusinessRuleError("INVALID_PHONE", "Enter a phone number of 3 to 15 digits.");
  }

  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** The sign-in email rule (NFKC, trim, lowercase), or null when blank. */
export function normalizeGuestEmail(raw: string | null | undefined): string | null {
  const normalized = raw ? normalizeEmail(raw) : "";

  return normalized === "" ? null : normalized;
}

/** True when text holds 13 or more digits in a row, which could be a card number. */
export function looksLikeCardNumber(text: string | null | undefined): boolean {
  return /[0-9]{13,}/.test(text ?? "");
}

/** Refuses free text that could hold a card number (CLAUDE.md rule 15). */
export function assertNoCardNumbers(fields: Record<string, string | null | undefined>): void {
  const found = Object.entries(fields).find(([, value]) => looksLikeCardNumber(value));

  if (found) {
    throw new BusinessRuleError(
      "LOOKS_LIKE_CARD_NUMBER",
      "That looks like a card number. Don't record payment details here.",
      { field: found[0] },
    );
  }
}

/** Search text that looks like a phone number (mostly digits) is matched as one. */
export function searchAsPhone(query: string): string | null {
  const digits = query.replace(/\D/g, "");

  return digits.length >= 3 && digits.length >= query.replace(/\s/g, "").length - 4 ? digits : null;
}
