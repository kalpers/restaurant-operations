import { eq, sql } from "drizzle-orm";

import { guestMessages } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// Phase 22 policy 3: guest message counts for the System health page. Addresses and bodies are
// never selected. Authorization belongs to the caller.

export type GuestMessageHealth = { queuedCount: number; failedCount: number };

export async function getGuestMessageHealth(
  executor: DatabaseExecutor,
  organizationId: string,
): Promise<GuestMessageHealth> {
  const [row] = await executor
    .select({
      queued: sql<number>`count(*) FILTER (WHERE ${guestMessages.status} IN ('QUEUED', 'SENDING'))::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${guestMessages.status} = 'FAILED')::int`,
    })
    .from(guestMessages)
    .where(eq(guestMessages.organizationId, organizationId));

  return { queuedCount: row?.queued ?? 0, failedCount: row?.failed ?? 0 };
}
