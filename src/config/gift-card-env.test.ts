import { describe, expect, it } from "vitest";

import { EnvValidationError, parseEnv } from "./env";
import { giftCardCodeKeyIssues, resolveGiftCardCodeKey } from "./gift-card-env";

// Phase 35 (policy 2): the gift card code key.

const BASE = { DATABASE_URL: "postgres://localhost/restaurant_ops", APP_BASE_URL: "http://localhost:3000" };

describe("gift card code key", () => {
  it("is refused in production when missing, naming the variable but no value", () => {
    expect(giftCardCodeKeyIssues({ NODE_ENV: "production", GIFT_CARD_CODE_KEY: undefined })).toEqual([
      "GIFT_CARD_CODE_KEY: is required in production",
    ]);
    expect(() => resolveGiftCardCodeKey({ NODE_ENV: "production", GIFT_CARD_CODE_KEY: undefined })).toThrow(EnvValidationError);
  });

  it("uses the configured key, and a fixed fallback outside production", () => {
    const key = "x".repeat(40);

    expect(resolveGiftCardCodeKey({ NODE_ENV: "production", GIFT_CARD_CODE_KEY: key })).toBe(key);

    const fallback = resolveGiftCardCodeKey({ NODE_ENV: "development", GIFT_CARD_CODE_KEY: undefined });

    expect(fallback).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveGiftCardCodeKey({ NODE_ENV: "test", GIFT_CARD_CODE_KEY: undefined })).toBe(fallback);
  });

  it("refuses a key under 32 characters and treats an empty value as unset", () => {
    expect(() => parseEnv({ ...BASE, GIFT_CARD_CODE_KEY: "short" })).toThrow(/GIFT_CARD_CODE_KEY: must be at least 32 characters/);
    expect(parseEnv({ ...BASE, GIFT_CARD_CODE_KEY: "" }).GIFT_CARD_CODE_KEY).toBeUndefined();
  });

  it("doesn't stop a production parse without the key, so `next build` works", () => {
    expect(() => parseEnv({ ...BASE, NODE_ENV: "production", NEXTAUTH_SECRET: "s".repeat(32) })).not.toThrow();
  });
});
