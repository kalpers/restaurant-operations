import { describe, expect, it } from "vitest";

import {
  assertNoCardNumbers,
  looksLikeCardNumber,
  normalizeGuestEmail,
  normalizePhone,
  searchAsPhone,
} from "./guest-contact";

describe("guest contact rules (Phase 21)", () => {
  it("keeps a phone's digits and a leading plus", () => {
    expect(normalizePhone("(555) 010-0199")).toBe("5550100199");
    expect(normalizePhone(" +44 20 7946 0958 ")).toBe("+442079460958");
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("refuses a phone with too few or too many digits", () => {
    expect(() => normalizePhone("12")).toThrow(expect.objectContaining({ code: "INVALID_PHONE" }));
    expect(() => normalizePhone("1234567890123456")).toThrow(expect.objectContaining({ code: "INVALID_PHONE" }));
  });

  it("normalizes email like sign-in does", () => {
    expect(normalizeGuestEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeGuestEmail("")).toBeNull();
  });

  it("refuses what could be a card number", () => {
    expect(looksLikeCardNumber("4111111111111111")).toBe(true);
    expect(looksLikeCardNumber("Table 12, birthday 2026")).toBe(false);
    expect(() => assertNoCardNumbers({ notes: "card 4111111111111111" })).toThrow(
      expect.objectContaining({ code: "LOOKS_LIKE_CARD_NUMBER" }),
    );
    expect(() => assertNoCardNumbers({ notes: "Window seat", preferences: null })).not.toThrow();
  });

  it("treats mostly-digit search text as a phone", () => {
    expect(searchAsPhone("555-0199")).toBe("5550199");
    expect(searchAsPhone("Ana")).toBeNull();
    expect(searchAsPhone("Room 12")).toBeNull();
  });
});
