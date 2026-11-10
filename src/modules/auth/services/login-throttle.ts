import { getThrottleConfig, type ThrottleConfig } from "@/config/auth-env";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import {
  deleteThrottle,
  findThrottles,
  recordThrottleFailure,
} from "../repositories/login-throttle-repository";
import { becameLocked, isLocked, throttleKey } from "./login-throttle-rules";

// Sign-in throttling (Phase 16 policies 1-9). Rows live in PostgreSQL, keyed by an HMAC of
// the normalized email and, behind a configured trusted proxy, of the client IP. Unknown
// emails are counted the same way, so a lockout never shows whether an account exists.

export type ThrottleKeys = { account: string; ip: string | null };

export function accountThrottleKey(normalizedEmail: string, config: ThrottleConfig = getThrottleConfig()): string {
  return throttleKey(config.secret, "account", normalizedEmail);
}

export function throttleKeysFor(
  normalizedEmail: string,
  clientIp: string | null | undefined,
  config: ThrottleConfig = getThrottleConfig(),
): ThrottleKeys {
  return {
    account: accountThrottleKey(normalizedEmail, config),
    ip: config.clientIpHeader && clientIp ? throttleKey(config.secret, "ip", clientIp) : null,
  };
}

/** True while either key is locked. */
export async function isThrottled(executor: DatabaseExecutor, keys: ThrottleKeys, now: Date): Promise<boolean> {
  const rows = await findThrottles(executor, [keys.account, ...(keys.ip ? [keys.ip] : [])]);

  return rows.some((row) => isLocked(row, now));
}

/** Counts one failure for each key. Says whether this failure locked the account key. */
export async function recordSignInFailure(
  executor: DatabaseExecutor,
  keys: ThrottleKeys,
  now: Date,
  config: ThrottleConfig = getThrottleConfig(),
): Promise<{ accountLocked: boolean }> {
  const accountLimits = { threshold: config.threshold, windowMs: config.windowMs, durationMs: config.durationMs };
  const account = await recordThrottleFailure(executor, keys.account, now, accountLimits);

  if (keys.ip) {
    await recordThrottleFailure(executor, keys.ip, now, { ...accountLimits, threshold: config.ipThreshold });
  }

  return { accountLocked: becameLocked(account, accountLimits) };
}

/** Clears the account key (success, unlock, reset). Returns whether a row existed. */
export function clearAccountThrottle(executor: DatabaseExecutor, normalizedEmail: string): Promise<boolean> {
  return deleteThrottle(executor, accountThrottleKey(normalizedEmail));
}

/** The current lock end for each of these accounts, keyed by normalized email. */
export async function findAccountLocks(
  executor: DatabaseExecutor,
  normalizedEmails: readonly string[],
  now: Date,
): Promise<Map<string, Date>> {
  if (normalizedEmails.length === 0) {
    return new Map();
  }

  const config = getThrottleConfig();
  const byKey = new Map(normalizedEmails.map((email) => [accountThrottleKey(email, config), email]));
  const locks = new Map<string, Date>();

  for (const row of await findThrottles(executor, [...byKey.keys()])) {
    const email = byKey.get(row.keyHash);

    if (email && row.lockedUntil && isLocked(row, now)) {
      locks.set(email, row.lockedUntil);
    }
  }

  return locks;
}
