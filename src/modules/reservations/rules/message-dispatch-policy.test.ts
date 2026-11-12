import { describe, expect, it } from "vitest";

import {
  isMessageDeadLetter,
  MESSAGE_RETRY_CAP_MS,
  messageRetryDelayMs,
  STALE_SENDING_MS,
  staleSendingCutoff,
} from "./message-dispatch-policy";

describe("message retry backoff (Phase 22 policy 3)", () => {
  it("starts at 5 s and doubles", () => {
    expect([1, 2, 3, 4].map(messageRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it("is capped at 15 minutes and never overflows", () => {
    expect(messageRetryDelayMs(9)).toBe(MESSAGE_RETRY_CAP_MS);
    expect(messageRetryDelayMs(1_000)).toBe(MESSAGE_RETRY_CAP_MS);
  });

  it("treats zero or fewer attempts as the first", () => {
    expect(messageRetryDelayMs(0)).toBe(5_000);
  });
});

describe("dead letter and crash recovery", () => {
  it("fails a message once attempts reach the maximum", () => {
    expect(isMessageDeadLetter(7, 8)).toBe(false);
    expect(isMessageDeadLetter(8, 8)).toBe(true);
  });

  it("recovers sends older than five minutes", () => {
    const now = new Date("2026-11-12T12:00:00Z");

    expect(now.getTime() - staleSendingCutoff(now).getTime()).toBe(STALE_SENDING_MS);
    expect(STALE_SENDING_MS).toBe(300_000);
  });
});
