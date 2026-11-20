import { createHash, randomBytes } from "node:crypto";

import { looksLikeCardNumber } from "./settlement-math";

// Phase 31 (policy 5): gift card codes. A code is 16 Crockford base32 characters (80 random
// bits) shown as four groups, e.g. `7KQ2-M9XD-4TPA-W3HR`. It works like cash, so only its
// SHA-256 and last four characters are kept. Pure apart from the random source.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

export type IssuedCode = {
  /** Shown once, never stored. */
  code: string;
  codeHash: string;
  lastFour: string;
};

function encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return output;
}

/** Groups a normalized code for display: `XXXX-XXXX-XXXX-XXXX`. */
export function formatGiftCardCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)!.join("-");
}

/**
 * Normalizes what staff typed or scanned: case, spaces and dashes don't matter, and the
 * Crockford look-alikes are read as digits (O as 0, I and L as 1). Returns null for anything
 * that can't be a code, which callers treat exactly like an unknown code.
 */
export function normalizeGiftCardCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

  if (cleaned.length !== CODE_LENGTH || [...cleaned].some((character) => !ALPHABET.includes(character))) {
    return null;
  }

  return cleaned;
}

/** Phase 33 (policy 13): a supplier's printed code is 8 to 24 letters and digits. */
const SUPPLIER_CODE = /^[0-9A-Z]{8,24}$/;

/**
 * Phase 33 (amendment 1): the one stored form of a typed or scanned code. A code that is a
 * valid app-style code (16 Crockford characters) is read that way; anything else is read as
 * a supplier code, upper-cased with spaces and dashes removed and no look-alike mapping.
 * Null when it can't be a code, or holds 13 digits in a row (never treated as a code).
 */
export function canonicalGiftCardCode(input: string): string | null {
  const generated = normalizeGiftCardCode(input);
  const canonical = generated ?? input.toUpperCase().replace(/[\s-]/g, "");

  if (!SUPPLIER_CODE.test(canonical) || looksLikeCardNumber(canonical)) {
    return null;
  }

  return canonical;
}

export type SupplierCodeCheck =
  | { ok: true; codeHash: string; lastFour: string }
  | { ok: false; reason: "INVALID" | "LOOKS_LIKE_CARD_NUMBER" };

/** Phase 33 (policy 13): whether a supplier's printed code can be used, and its hash. */
export function checkSupplierCode(input: string): SupplierCodeCheck {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");

  if (/[0-9]{13,}/.test(cleaned)) {
    return { ok: false, reason: "LOOKS_LIKE_CARD_NUMBER" };
  }

  const canonical = canonicalGiftCardCode(input);

  if (!canonical) {
    return { ok: false, reason: "INVALID" };
  }

  return { ok: true, codeHash: hashGiftCardCode(canonical), lastFour: canonical.slice(-4) };
}

export function hashGiftCardCode(normalized: string): string {
  return createHash("sha256").update(`gift-card:${normalized}`).digest("hex");
}

/** A new random code with its hash and last four. Never 13 digits in a row. */
export function generateGiftCardCode(random: (size: number) => Buffer = randomBytes): IssuedCode {
  for (;;) {
    const normalized = encode(random(10));

    if (!looksLikeCardNumber(normalized)) {
      return { code: formatGiftCardCode(normalized), codeHash: hashGiftCardCode(normalized), lastFour: normalized.slice(-4) };
    }
  }
}

/** The non-secret card number printed on receipts: `GC-000123`. */
export function formatGiftCardNumber(cardNumber: number): string {
  return `GC-${String(cardNumber).padStart(6, "0")}`;
}

/** Reads `GC-000123`, `gc123` or `123` back into the number; null when it isn't one. */
export function parseGiftCardNumber(input: string): number | null {
  const match = /^(?:GC-?)?0*(\d{1,9})$/i.exec(input.trim());

  if (!match) {
    return null;
  }

  const value = Number(match[1]);

  return value > 0 ? value : null;
}
