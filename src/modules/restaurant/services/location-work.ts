import { and, count, eq } from "drizzle-orm";

import { tableSessions } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/** Phase 23 (policy 3): seated parties would be stranded if the location closed. */
export async function findOpenSeatingWork(transaction: DatabaseTransaction, locationId: string): Promise<string[]> {
  const [active] = await transaction
    .select({ total: count() })
    .from(tableSessions)
    .where(and(eq(tableSessions.locationId, locationId), eq(tableSessions.status, "ACTIVE")));

  return (active?.total ?? 0) > 0 ? ["seated parties"] : [];
}
