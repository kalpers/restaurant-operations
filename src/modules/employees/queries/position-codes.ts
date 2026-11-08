import { eq } from "drizzle-orm";

import { positions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** Position IDs to their stable codes. A position holds no wage, so nothing else is read. */
export async function findPositionCodes(
  executor: DatabaseExecutor,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await executor
    .select({ id: positions.id, code: positions.code })
    .from(positions)
    .where(eq(positions.organizationId, organizationId));

  return new Map(rows.map((row) => [row.id, row.code]));
}
