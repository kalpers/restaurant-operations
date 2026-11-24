import { and, eq, inArray, sql } from "drizzle-orm";

import { orders } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/**
 * Phase 36 (policy 7): what a guest party's checks come to before tax, OPEN and CLOSED, for an
 * event's minimum spend. Read-only; voided checks don't count.
 */
export async function sumPartyCheckSubtotals(
  executor: DatabaseExecutor,
  guestPartyId: string,
): Promise<{ subtotal: string; checks: number }> {
  const [row] = await executor
    .select({
      subtotal: sql<string>`coalesce(sum(${orders.subtotal}), 0)::numeric(12,2)::text`,
      checks: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(and(eq(orders.guestPartyId, guestPartyId), inArray(orders.status, ["OPEN", "CLOSED"])));

  return { subtotal: row?.subtotal ?? "0.00", checks: row?.checks ?? 0 };
}
