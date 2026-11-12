import { describe, expect, it } from "vitest";

import { normalizeMessageAddress, suppressionHash, toE164 } from "./message-address";

describe("toE164 (Phase 22 policy 5)", () => {
  it("reads US and Canadian national numbers with the location country", () => {
    expect(toE164("(555) 123-4567", "US")).toBe("+15551234567");
    expect(toE164("1 555 123 4567", "us")).toBe("+15551234567");
    expect(toE164("555-123-4567", "CA")).toBe("+15551234567");
  });

  it("keeps a number typed with a country code", () => {
    expect(toE164("+44 20 7946 0958", "US")).toBe("+442079460958");
  });

  it("refuses numbers it can't turn into E.164", () => {
    expect(toE164("123-4567", "US")).toBeNull();
    expect(toE164("2079460958", "GB")).toBeNull();
    expect(toE164("", "US")).toBeNull();
    expect(toE164(null, "US")).toBeNull();
    expect(toE164("12", "US")).toBeNull();
  });
});

describe("normalizeMessageAddress", () => {
  it("normalizes email like sign-in and refuses a malformed one", () => {
    expect(normalizeMessageAddress("EMAIL", "  Guest@Example.COM ")).toBe("guest@example.com");
    expect(normalizeMessageAddress("EMAIL", "not-an-email")).toBeNull();
  });

  it("accepts only E.164 for SMS", () => {
    expect(normalizeMessageAddress("SMS", "+15551234567")).toBe("+15551234567");
    expect(normalizeMessageAddress("SMS", "5551234567")).toBeNull();
  });
});

describe("suppressionHash (D6)", () => {
  const key = "k".repeat(32);

  it("is a 64-character hex HMAC that never contains the address", () => {
    const hash = suppressionHash(key, "SMS", "+15551234567");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("5551234567");
  });

  it("depends on the channel and the key", () => {
    const sms = suppressionHash(key, "SMS", "+15551234567");

    expect(suppressionHash(key, "SMS", "+15551234567")).toBe(sms);
    expect(suppressionHash(key, "EMAIL", "+15551234567")).not.toBe(sms);
    expect(suppressionHash("j".repeat(32), "SMS", "+15551234567")).not.toBe(sms);
  });
});
