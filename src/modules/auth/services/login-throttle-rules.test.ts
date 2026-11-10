import { describe, expect, it } from "vitest";

import {
  becameLocked,
  clientIpFromHeader,
  isLocked,
  nextThrottleState,
  throttleKey,
  type ThrottleState,
} from "./login-throttle-rules";

const limits = { threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 };
const start = new Date("2026-11-10T12:00:00.000Z");
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

function fail(times: number, from?: ThrottleState, when = start): ThrottleState | undefined {
  let state = from;

  for (let index = 0; index < times; index += 1) {
    state = nextThrottleState(state, when, limits);
  }

  return state;
}

describe("sign-in throttle window", () => {
  it("counts failures inside the window", () => {
    expect(fail(3)).toEqual({ failureCount: 3, windowStartedAt: start, lockedUntil: null });
  });

  it("starts a new window once the old one has expired", () => {
    const state = nextThrottleState(fail(4), at(15), limits);

    expect(state).toEqual({ failureCount: 1, windowStartedAt: at(15), lockedUntil: null });
  });

  it("does not lock at 4 failures and locks at the 5th", () => {
    const four = fail(4)!;
    const five = nextThrottleState(four, at(1), limits);

    expect(isLocked(four, at(1))).toBe(false);
    expect(becameLocked(four, limits)).toBe(false);
    expect(five.lockedUntil).toEqual(at(16));
    expect(becameLocked(five, limits)).toBe(true);
    expect(isLocked(five, at(1))).toBe(true);
  });

  it("expires the lock after the duration and counts afresh", () => {
    const locked = fail(5)!;

    expect(isLocked(locked, at(14.99))).toBe(true);
    expect(isLocked(locked, at(15))).toBe(false);
    expect(nextThrottleState(locked, at(15), limits)).toEqual({
      failureCount: 1,
      windowStartedAt: at(15),
      lockedUntil: null,
    });
  });

  it("restarts after an expired lock even while a longer window would still run", () => {
    const long = { threshold: 2, windowMs: 60 * 60_000, durationMs: 5 * 60_000 };
    const locked = nextThrottleState(nextThrottleState(undefined, start, long), start, long);

    expect(isLocked(locked, at(1))).toBe(true);
    expect(nextThrottleState(locked, at(6), long).failureCount).toBe(1);
  });

  it("has no lock without a row (success deletes the row)", () => {
    expect(isLocked(undefined, start)).toBe(false);
  });

  it("keys by HMAC, never the value, and separates kinds and secrets", () => {
    const key = throttleKey("s".repeat(32), "account", "ana@example.test");

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("ana");
    expect(throttleKey("s".repeat(32), "ip", "ana@example.test")).not.toBe(key);
    expect(throttleKey("t".repeat(32), "account", "ana@example.test")).not.toBe(key);
  });
});

describe("client IP header", () => {
  it("takes the rightmost entry, which the trusted proxy appended", () => {
    expect(clientIpFromHeader("203.0.113.9, 10.0.0.2")).toBe("10.0.0.2");
    expect(clientIpFromHeader(["1.1.1.1", "198.51.100.4"])).toBe("198.51.100.4");
    expect(clientIpFromHeader(" 198.51.100.4 ")).toBe("198.51.100.4");
  });

  it("ignores a missing, empty or oversized value", () => {
    expect(clientIpFromHeader(undefined)).toBeNull();
    expect(clientIpFromHeader("")).toBeNull();
    expect(clientIpFromHeader("x".repeat(101))).toBeNull();
  });
});
