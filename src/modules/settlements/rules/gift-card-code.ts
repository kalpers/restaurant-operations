import { createHash, createHmac, randomBytes } from "node:crypto";

import { looksLikeCardNumber } from "./settlement-math";

// Phase 31 (policy 5): gift card codes. A code is 16 Crockford base32 characters (80 random
// bits) shown as four groups, e.g. `7KQ2-M9XD-4TPA-W3HR`. It works like cash, so only its
// keyed hash and last four characters are kept. Pure apart from the random source; the key
// is always passed in (Phase 35: read only in src/config/gift-card-env.ts).

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

export type IssuedCode = {
  /** Shown once, never stored. */
  code: string;
  /** The keyed hash (Phase 35). */
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
  | { ok: true; codeHash: string; legacyCodeHash: string; lastFour: string }
  | { ok: false; reason: "INVALID" | "LOOKS_LIKE_CARD_NUMBER" };

/**
 * Phase 33 (policy 13): whether a supplier's printed code can be used, with its keyed hash
 * and (Phase 35, for rows not yet re-keyed) its legacy hash.
 */
export function checkSupplierCode(input: string, key: string): SupplierCodeCheck {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");

  if (/[0-9]{13,}/.test(cleaned)) {
    return { ok: false, reason: "LOOKS_LIKE_CARD_NUMBER" };
  }

  const canonical = canonicalGiftCardCode(input);

  if (!canonical) {
    return { ok: false, reason: "INVALID" };
  }

  const hashes = giftCardCodeHashes(canonical, key);

  return { ok: true, codeHash: hashes.keyed, legacyCodeHash: hashes.legacy, lastFour: canonical.slice(-4) };
}

/** Phase 35 (policy 4): which form a stored `code_hash` is in. */
export type GiftCardCodeHashScheme = "SHA256" | "HMAC_SHA256";

/** The form before Phase 35: an unkeyed SHA-256. Only for matching rows not yet re-keyed. */
export function legacyGiftCardCodeHash(normalized: string): string {
  return createHash("sha256").update(`gift-card:${normalized}`).digest("hex");
}

/**
 * Phase 35 (policy 3): the keyed form of a legacy hash. Wrapping the old digest, rather than
 * hashing the code afresh, is what lets a stored row be re-keyed without its code.
 */
export function rekeyLegacyHash(legacyHash: string, key: string): string {
  return createHmac("sha256", key).update(legacyHash).digest("hex");
}

/** Phase 35 (policy 3): the stored hash of a code, HMAC-SHA256 with the server key. */
export function keyedGiftCardCodeHash(normalized: string, key: string): string {
  return rekeyLegacyHash(legacyGiftCardCodeHash(normalized), key);
}

/** Both forms of a code's hash, for lookups that must also find rows not yet re-keyed. */
export function giftCardCodeHashes(normalized: string, key: string): { keyed: string; legacy: string } {
  const legacy = legacyGiftCardCodeHash(normalized);

  return { keyed: rekeyLegacyHash(legacy, key), legacy };
}

/** A new random code with its keyed hash and last four. Never 13 digits in a row. */
export function generateGiftCardCode(key: string, random: (size: number) => Buffer = randomBytes): IssuedCode {
  for (;;) {
    const normalized = encode(random(10));

    if (!looksLikeCardNumber(normalized)) {
      return { code: formatGiftCardCode(normalized), codeHash: keyedGiftCardCodeHash(normalized, key), lastFour: normalized.slice(-4) };
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
