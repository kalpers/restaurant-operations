import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import { publicThrottles } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// Phase 22 public throttling (policy 10): a fixed window per key. Every attempt counts, booked
// or refused, so a script can't probe slots or contacts without limit.

/** An HMAC of the kind and value, so no IP or contact is stored. */
export function publicThrottleKey(secret: string, kind: "ip" | "contact", value: string): string {
  return createHmac("sha256", secret).update(`public-booking:${kind}:${value}`).digest("hex");
}

/**
 * Counts one attempt with a single upsert and returns the count in the current window. A
 * window older than `windowMs` starts again at 1.
 */
export async function countPublicAttempt(
  executor: DatabaseExecutor,
  keyHash: string,
  now: Date,
  windowMs: number,
): Promise<number> {
  const nowText = now.toISOString();
  const restart = sql`(${publicThrottles.windowStartedAt} <= ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz)`;
  const [row] = await executor
    .insert(publicThrottles)
    .values({ keyHash, attempts: 1, windowStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: publicThrottles.keyHash,
      set: {
        attempts: sql`(CASE WHEN ${restart} THEN 1 ELSE ${publicThrottles.attempts} + 1 END)`,
        windowStartedAt: sql`(CASE WHEN ${restart} THEN ${nowText}::timestamptz ELSE ${publicThrottles.windowStartedAt} END)`,
        updatedAt: now,
      },
    })
    .returning({ attempts: publicThrottles.attempts });

  return row?.attempts ?? 1;
}
