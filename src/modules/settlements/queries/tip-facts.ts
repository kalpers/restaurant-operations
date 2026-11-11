import { and, eq, inArray } from "drizzle-orm";

import { tipDistributions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/**
 * Policy A8: the time clock may not change hours on a business date whose tips are already
 * FINALIZED. Of the given dates, the ones with a FINALIZED distribution at the location.
 */
export async function findFinalizedTipDates(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDates: readonly string[] },
): Promise<string[]> {
  const dates = [...new Set(input.businessDates)];

  if (dates.length === 0) {
    return [];
  }

  const rows = await executor
    .select({ businessDate: tipDistributions.businessDate })
    .from(tipDistributions)
    .where(
      and(
        eq(tipDistributions.locationId, input.locationId),
        eq(tipDistributions.status, "FINALIZED"),
        inArray(tipDistributions.businessDate, dates),
      ),
    );

  return rows.map((row) => row.businessDate);
}
