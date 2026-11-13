import { and, count, eq } from "drizzle-orm";

import { orders } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/** Phase 23 (policy 3): open checks would be stranded if the location closed. */
export async function findOpenOrderWork(transaction: DatabaseTransaction, locationId: string): Promise<string[]> {
  const [open] = await transaction
    .select({ total: count() })
    .from(orders)
    .where(and(eq(orders.locationId, locationId), eq(orders.status, "OPEN")));

  return (open?.total ?? 0) > 0 ? ["open checks"] : [];
}
