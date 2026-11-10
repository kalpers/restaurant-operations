import { eq, inArray, sql } from "drizzle-orm";

import { loginThrottles } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import type { ThrottleLimits, ThrottleState } from "../services/login-throttle-rules";

export function findThrottles(executor: DatabaseExecutor, keys: readonly string[]) {
  return executor
    .select({
      keyHash: loginThrottles.keyHash,
      failureCount: loginThrottles.failureCount,
      windowStartedAt: loginThrottles.windowStartedAt,
      lockedUntil: loginThrottles.lockedUntil,
    })
    .from(loginThrottles)
    .where(inArray(loginThrottles.keyHash, [...keys]));
}

/**
 * Records one failure with a single upsert, so concurrent failures can't both read a stale
 * count. Mirrors `nextThrottleState`: a new window when the old one or a lock has expired,
 * and a lock at the threshold.
 */
export async function recordThrottleFailure(
  executor: DatabaseExecutor,
  keyHash: string,
  now: Date,
  limits: ThrottleLimits,
): Promise<ThrottleState> {
  const windowCutoff = new Date(now.getTime() - limits.windowMs);
  const lockUntil = new Date(now.getTime() + limits.durationMs);
  // Raw SQL parameters are passed as ISO text: the driver serializes only typed columns' Dates.
  const nowText = now.toISOString();
  const restart = sql`(${loginThrottles.windowStartedAt} <= ${windowCutoff.toISOString()}::timestamptz OR (${loginThrottles.lockedUntil} IS NOT NULL AND ${loginThrottles.lockedUntil} <= ${nowText}::timestamptz))`;
  const nextCount = sql`(CASE WHEN ${restart} THEN 1 ELSE ${loginThrottles.failureCount} + 1 END)`;

  const [row] = await executor
    .insert(loginThrottles)
    .values({
      keyHash,
      failureCount: 1,
      windowStartedAt: now,
      lockedUntil: limits.threshold <= 1 ? lockUntil : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: loginThrottles.keyHash,
      set: {
        failureCount: nextCount,
        windowStartedAt: sql`(CASE WHEN ${restart} THEN ${nowText}::timestamptz ELSE ${loginThrottles.windowStartedAt} END)`,
        lockedUntil: sql`(CASE WHEN ${nextCount} >= ${limits.threshold}::int THEN ${lockUntil.toISOString()}::timestamptz WHEN ${restart} THEN NULL ELSE ${loginThrottles.lockedUntil} END)`,
        updatedAt: now,
      },
    })
    .returning({
      failureCount: loginThrottles.failureCount,
      windowStartedAt: loginThrottles.windowStartedAt,
      lockedUntil: loginThrottles.lockedUntil,
    });

  if (!row) {
    throw new Error("Throttle upsert returned no row.");
  }

  return row;
}

export async function deleteThrottle(executor: DatabaseExecutor, keyHash: string): Promise<boolean> {
  const rows = await executor
    .delete(loginThrottles)
    .where(eq(loginThrottles.keyHash, keyHash))
    .returning({ keyHash: loginThrottles.keyHash });

  return rows.length > 0;
}
