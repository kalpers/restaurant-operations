import { createHmac } from "node:crypto";

// Sign-in throttling rules (Phase 16, README section 9). Pure, so the window, threshold
// and lock edges are unit-tested. The repository's upsert applies the same rules in SQL,
// atomically; integration tests check the two agree.

export type ThrottleState = {
  failureCount: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
};

export type ThrottleLimits = {
  threshold: number;
  windowMs: number;
  durationMs: number;
};

/** An HMAC of the value, so the typed email or IP is never stored. */
export function throttleKey(secret: string, kind: "account" | "ip", value: string): string {
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
}

export function isLocked(state: Pick<ThrottleState, "lockedUntil"> | undefined, now: Date): boolean {
  return state?.lockedUntil != null && state.lockedUntil.getTime() > now.getTime();
}

/** A failure starts a new window when the old one, or a lock, has expired. */
function restarts(previous: ThrottleState, now: Date, limits: ThrottleLimits): boolean {
  const windowExpired = previous.windowStartedAt.getTime() + limits.windowMs <= now.getTime();
  const lockExpired = previous.lockedUntil !== null && previous.lockedUntil.getTime() <= now.getTime();

  return windowExpired || lockExpired;
}

/** The state after one more failure. Reaching the threshold locks until now + duration. */
export function nextThrottleState(
  previous: ThrottleState | undefined,
  now: Date,
  limits: ThrottleLimits,
): ThrottleState {
  const restart = !previous || restarts(previous, now, limits);
  const failureCount = restart ? 1 : previous.failureCount + 1;

  return {
    failureCount,
    windowStartedAt: restart ? now : previous.windowStartedAt,
    lockedUntil:
      failureCount >= limits.threshold
        ? new Date(now.getTime() + limits.durationMs)
        : restart
          ? null
          : previous.lockedUntil,
  };
}

/** True for exactly the failure that reached the threshold, so a lock is audited once. */
export function becameLocked(state: ThrottleState, limits: Pick<ThrottleLimits, "threshold">): boolean {
  return state.failureCount === limits.threshold;
}

/**
 * The client IP from a trusted proxy's header. A proxy appends the address it saw, so the
 * rightmost entry is the one this deployment's single trusted proxy wrote.
 */
export function clientIpFromHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  const entry = raw?.split(",").at(-1)?.trim();

  return entry && entry.length <= 100 ? entry : null;
}
