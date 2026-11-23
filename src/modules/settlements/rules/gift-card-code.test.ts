import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalGiftCardCode,
  checkSupplierCode,
  formatGiftCardNumber,
  generateGiftCardCode,
  giftCardCodeHashes,
  keyedGiftCardCodeHash,
  legacyGiftCardCodeHash,
  normalizeGiftCardCode,
  parseGiftCardNumber,
  rekeyLegacyHash,
} from "./gift-card-code";
import { looksLikeCardNumber } from "./settlement-math";

const KEY = "k".repeat(32);

describe("gift card codes", () => {
  it("makes 16 Crockford characters in four groups, with the keyed hash of the normalized code", () => {
    const issued = generateGiftCardCode(KEY);

    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(issued.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.codeHash).toBe(keyedGiftCardCodeHash(normalizeGiftCardCode(issued.code)!, KEY));
    expect(issued.lastFour).toBe(issued.code.slice(-4));
  });

  it("never returns 13 digits in a row, drawing again when the random bytes would", () => {
    let calls = 0;
    // All-zero bytes encode to sixteen "0" characters, which would look like a card number.
    const random = (size: number) => (calls++ === 0 ? Buffer.alloc(size, 0) : Buffer.alloc(size, 0xff));
    const issued = generateGiftCardCode(KEY, random);

    expect(calls).toBe(2);
    expect(looksLikeCardNumber(issued.code.replace(/-/g, ""))).toBe(false);
    expect(issued.code).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });

  it("gives distinct codes", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateGiftCardCode(KEY).code));

    expect(codes.size).toBe(200);
  });

  it("ignores case, spaces and dashes and reads look-alikes as digits", () => {
    expect(normalizeGiftCardCode("7kq2-m9xd 4tpa-w3hr")).toBe("7KQ2M9XD4TPAW3HR");
    expect(normalizeGiftCardCode("OIL0-0000-0000-0000")).toBe("0110000000000000");
  });

  it("refuses anything that can't be a code", () => {
    expect(normalizeGiftCardCode("7KQ2-M9XD-4TPA")).toBeNull();
    expect(normalizeGiftCardCode("7KQ2-M9XD-4TPA-W3HRX")).toBeNull();
    expect(normalizeGiftCardCode("UUUU-UUUU-UUUU-UUUU")).toBeNull();
    expect(normalizeGiftCardCode("")).toBeNull();
  });

  it("formats and parses the non-secret card number", () => {
    expect(formatGiftCardNumber(123)).toBe("GC-000123");
    expect(parseGiftCardNumber("GC-000123")).toBe(123);
    expect(parseGiftCardNumber("gc123")).toBe(123);
    expect(parseGiftCardNumber("  42 ")).toBe(42);
    expect(parseGiftCardNumber("GC-0")).toBeNull();
    expect(parseGiftCardNumber("7KQ2-M9XD")).toBeNull();
  });
});

// Phase 33 (policy 13, amendment 1): supplier-printed codes.
describe("supplier codes", () => {
  it("reads a generated-style code with the look-alike rules, and anything else as typed", () => {
    expect(canonicalGiftCardCode("7kq2-m9xd-4tpa-w3hr")).toBe("7KQ2M9XD4TPAW3HR");
    expect(canonicalGiftCardCode("7KQ2-M9XD-4TPA-W3HO")).toBe("7KQ2M9XD4TPAW3H0");
    expect(canonicalGiftCardCode("demo-prnt-2026")).toBe("DEMOPRNT2026");
    expect(canonicalGiftCardCode("ABCD OLIU 12")).toBe("ABCDOLIU12");
  });

  it("refuses codes that are too short or long, or hold other characters", () => {
    expect(checkSupplierCode("ABC1234", KEY)).toEqual({ ok: false, reason: "INVALID" });
    expect(checkSupplierCode("A".repeat(25), KEY)).toEqual({ ok: false, reason: "INVALID" });
    expect(checkSupplierCode("ABCD_1234", KEY)).toEqual({ ok: false, reason: "INVALID" });
    expect(canonicalGiftCardCode("short")).toBeNull();
  });

  it("refuses 13 or more digits in a row, which could be a payment card", () => {
    expect(checkSupplierCode("4111 1111 1111 1111", KEY)).toEqual({ ok: false, reason: "LOOKS_LIKE_CARD_NUMBER" });
    expect(checkSupplierCode("GC1234567890123", KEY)).toEqual({ ok: false, reason: "LOOKS_LIKE_CARD_NUMBER" });
    expect(canonicalGiftCardCode("4111111111111111")).toBeNull();
  });

  it("stores the same hash however the code is typed, and its last four", () => {
    const typed = checkSupplierCode("demo-prnt-2026", KEY);
    const again = checkSupplierCode("DEMO PRNT 2026", KEY);

    expect(typed).toEqual(again);
    expect(typed).toMatchObject({
      ok: true,
      lastFour: "2026",
      codeHash: keyedGiftCardCodeHash("DEMOPRNT2026", KEY),
      legacyCodeHash: legacyGiftCardCodeHash("DEMOPRNT2026"),
    });
  });
});

// Phase 35 (policies 3 and 6): keyed hashes.
describe("keyed code hashes", () => {
  it("is HMAC-SHA256 with the key over the old SHA-256, as 64 lowercase hex", () => {
    const legacy = createHash("sha256").update("gift-card:DEMOPRNT2026").digest("hex");

    expect(legacyGiftCardCodeHash("DEMOPRNT2026")).toBe(legacy);
    expect(keyedGiftCardCodeHash("DEMOPRNT2026", KEY)).toBe(createHmac("sha256", KEY).update(legacy).digest("hex"));
    expect(keyedGiftCardCodeHash("DEMOPRNT2026", KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-keys a stored legacy hash to exactly what a newly written row holds", () => {
    const { keyed, legacy } = giftCardCodeHashes("7KQ2M9XD4TPAW3HR", KEY);

    expect(rekeyLegacyHash(legacy, KEY)).toBe(keyed);
    expect(keyed).not.toBe(legacy);
  });

  it("gives a different hash under a different key", () => {
    expect(keyedGiftCardCodeHash("DEMOPRNT2026", KEY)).not.toBe(keyedGiftCardCodeHash("DEMOPRNT2026", "j".repeat(32)));
  });
});
