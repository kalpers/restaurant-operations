import { and, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { locations, managerLogEntries, preShiftNotes } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import { containsPattern, formatLogNumber } from "../rules/manager-log-rules";

// Phase 33 (policies 2–4): free text in the manager log and pre-shift notes that may mention
// someone. A broad first pass only: text containing any of the given words (any case), or
// whose digits contain any of the given digit runs. The caller decides what is a real mention.
// Redacted entries and notes have no text left and are never returned.

export type BriefingTextCandidate = {
  kind: "LOG_ENTRY" | "NOTE";
  id: string;
  locationId: string;
  locationName: string;
  businessDate: string;
  /** `LOG-000123`, or the note's title. */
  label: string;
  /** The entry's body, or the note's title and body. */
  text: string;
};

export type BriefingTextQuery = {
  organizationId: string;
  locationIds: readonly string[];
  words: readonly string[];
  digitRuns: readonly string[];
};

export async function findBriefingTextCandidates(
  executor: DatabaseExecutor,
  query: BriefingTextQuery,
): Promise<BriefingTextCandidate[]> {
  if (query.locationIds.length === 0 || query.words.length + query.digitRuns.length === 0) {
    return [];
  }

  const matching = (texts: SQL[]): SQL =>
    or(
      ...query.words.flatMap((word) => texts.map((text) => ilike(text, containsPattern(word)))),
      ...query.digitRuns.flatMap((digits) =>
        texts.map((text) => sql`regexp_replace(${text}, '[^0-9]', '', 'g') LIKE ${containsPattern(digits)}`),
      ),
    )!;
  const entries = await executor
    .select({
      id: managerLogEntries.id,
      locationId: managerLogEntries.locationId,
      locationName: locations.name,
      businessDate: managerLogEntries.businessDate,
      entryNumber: managerLogEntries.entryNumber,
      body: managerLogEntries.body,
    })
    .from(managerLogEntries)
    .innerJoin(locations, eq(locations.id, managerLogEntries.locationId))
    .where(
      and(
        eq(managerLogEntries.organizationId, query.organizationId),
        inArray(managerLogEntries.locationId, [...query.locationIds]),
        isNull(managerLogEntries.redactedAt),
        matching([sql`${managerLogEntries.body}`]),
      ),
    );
  const notes = await executor
    .select({
      id: preShiftNotes.id,
      locationId: preShiftNotes.locationId,
      locationName: locations.name,
      businessDate: preShiftNotes.businessDate,
      title: preShiftNotes.title,
      body: preShiftNotes.body,
    })
    .from(preShiftNotes)
    .innerJoin(locations, eq(locations.id, preShiftNotes.locationId))
    .where(
      and(
        eq(preShiftNotes.organizationId, query.organizationId),
        inArray(preShiftNotes.locationId, [...query.locationIds]),
        isNull(preShiftNotes.redactedAt),
        matching([sql`${preShiftNotes.title}`, sql`${preShiftNotes.body}`]),
      ),
    );

  return [
    ...entries.map((row) => ({
      kind: "LOG_ENTRY" as const,
      id: row.id,
      locationId: row.locationId,
      locationName: row.locationName,
      businessDate: row.businessDate,
      label: formatLogNumber(row.entryNumber),
      text: row.body,
    })),
    ...notes.map((row) => ({
      kind: "NOTE" as const,
      id: row.id,
      locationId: row.locationId,
      locationName: row.locationName,
      businessDate: row.businessDate,
      label: row.title,
      text: `${row.title}\n${row.body}`,
    })),
  ].sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.label.localeCompare(b.label));
}
