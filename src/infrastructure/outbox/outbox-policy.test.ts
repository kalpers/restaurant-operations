import { describe, expect, it } from "vitest";

import { isDeadLetter, retryDelayMs } from "./outbox-policy";

describe("outbox backoff", () => {
  it("doubles from 1 s and caps at 5 minutes for attempts 1-12", () => {
    expect(Array.from({ length: 12 }, (_, index) => retryDelayMs(index + 1))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ]);
  });

  it("never exceeds the cap for very large attempt counts", () => {
    expect(retryDelayMs(10_000)).toBe(300_000);
  });

  it("dead-letters exactly at the maximum attempts", () => {
    expect(isDeadLetter(9, 10)).toBe(false);
    expect(isDeadLetter(10, 10)).toBe(true);
    expect(isDeadLetter(11, 10)).toBe(true);
    expect(isDeadLetter(1, 1)).toBe(true);
  });
});
