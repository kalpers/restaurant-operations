import { describe, expect, it } from "vitest";

import {
  formatGiftCardNumber,
  generateGiftCardCode,
  hashGiftCardCode,
  normalizeGiftCardCode,
  parseGiftCardNumber,
} from "./gift-card-code";
import { looksLikeCardNumber } from "./settlement-math";

describe("gift card codes", () => {
  it("makes 16 Crockford characters in four groups, with the hash of the normalized code", () => {
    const issued = generateGiftCardCode();

    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(issued.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.codeHash).toBe(hashGiftCardCode(normalizeGiftCardCode(issued.code)!));
    expect(issued.lastFour).toBe(issued.code.slice(-4));
  });

  it("never returns 13 digits in a row, drawing again when the random bytes would", () => {
    let calls = 0;
    // All-zero bytes encode to sixteen "0" characters, which would look like a card number.
    const random = (size: number) => (calls++ === 0 ? Buffer.alloc(size, 0) : Buffer.alloc(size, 0xff));
    const issued = generateGiftCardCode(random);

    expect(calls).toBe(2);
    expect(looksLikeCardNumber(issued.code.replace(/-/g, ""))).toBe(false);
    expect(issued.code).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });

  it("gives distinct codes", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateGiftCardCode().code));

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
