import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";

import { managerLogEntries, managerLogNumberCounters } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";

import { containsPattern } from "../rules/manager-log-rules";

export type ManagerLogRow = typeof managerLogEntries.$inferSelect;

/** The next entry number for the organization, under the counter row's lock. */
export async function nextLogNumber(transaction: DatabaseTransaction, organizationId: string): Promise<number> {
  await transaction
    .insert(managerLogNumberCounters)
    .values({ organizationId, lastNumber: 0 })
    .onConflictDoNothing({ target: managerLogNumberCounters.organizationId });

  const [counter] = await transaction
    .update(managerLogNumberCounters)
    .set({ lastNumber: sql`${managerLogNumberCounters.lastNumber} + 1` })
    .where(eq(managerLogNumberCounters.organizationId, organizationId))
    .returning({ lastNumber: managerLogNumberCounters.lastNumber });

  return counter!.lastNumber;
}

export async function findLogEntry(
  executor: DatabaseExecutor,
  input: { entryId: string; locationId: string; lock?: boolean },
): Promise<ManagerLogRow | undefined> {
  const query = executor
    .select()
    .from(managerLogEntries)
    .where(and(eq(managerLogEntries.id, input.entryId), eq(managerLogEntries.locationId, input.locationId)));
  const [row] = input.lock ? await query.for("update") : await query;

  return row;
}

export type LogFilter = {
  locationId: string;
  from: string;
  to: string;
  category?: string | null;
  text?: string | null;
  limit: number;
};

/** Entries in a range of business dates, newest date first, then in the order written. */
export async function findLogEntries(executor: DatabaseExecutor, filter: LogFilter): Promise<ManagerLogRow[]> {
  return executor
    .select()
    .from(managerLogEntries)
    .where(
      and(
        eq(managerLogEntries.locationId, filter.locationId),
        gte(managerLogEntries.businessDate, filter.from),
        lte(managerLogEntries.businessDate, filter.to),
        filter.category ? eq(managerLogEntries.category, filter.category) : undefined,
        filter.text ? ilike(managerLogEntries.body, containsPattern(filter.text)) : undefined,
      ),
    )
    .orderBy(desc(managerLogEntries.businessDate), asc(managerLogEntries.createdAt), asc(managerLogEntries.entryNumber))
    .limit(filter.limit);
}

/** Entry ID to entry number, for the entries named. */
export async function findLogNumbers(
  executor: DatabaseExecutor,
  input: { organizationId: string; ids: readonly string[] },
): Promise<Map<string, number>> {
  if (input.ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ id: managerLogEntries.id, entryNumber: managerLogEntries.entryNumber })
    .from(managerLogEntries)
    .where(and(eq(managerLogEntries.organizationId, input.organizationId), inArray(managerLogEntries.id, [...new Set(input.ids)])));

  return new Map(rows.map((row) => [row.id, row.entryNumber]));
}

/** The corrections of each entry named: corrected entry ID to the correcting entry numbers. */
export async function findCorrections(
  executor: DatabaseExecutor,
  input: { organizationId: string; ids: readonly string[] },
): Promise<Map<string, number[]>> {
  if (input.ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ correctsEntryId: managerLogEntries.correctsEntryId, entryNumber: managerLogEntries.entryNumber })
    .from(managerLogEntries)
    .where(
      and(
        eq(managerLogEntries.organizationId, input.organizationId),
        inArray(managerLogEntries.correctsEntryId, [...new Set(input.ids)]),
      ),
    )
    .orderBy(asc(managerLogEntries.entryNumber));
  const result = new Map<string, number[]>();

  for (const row of rows) {
    const list = result.get(row.correctsEntryId!) ?? [];

    list.push(row.entryNumber);
    result.set(row.correctsEntryId!, list);
  }

  return result;
}
