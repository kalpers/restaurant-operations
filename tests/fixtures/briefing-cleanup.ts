import { sql } from "drizzle-orm";

import type { Database } from "@/db";
import { managerLogEntries, managerLogNumberCounters, preShiftNotePositions, preShiftNotes } from "@/db/schema";

/**
 * Phase 32: every manager log entry and pre-shift note. The log is append-only, so its guard
 * is lifted for this transaction only (test database). They reference users, employees,
 * positions and locations, so this runs before those are cleared.
 */
export async function clearBriefingData(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`ALTER TABLE manager_log_entries DISABLE TRIGGER manager_log_entries_guard`);
    await transaction.execute(sql`UPDATE manager_log_entries SET corrects_entry_id = NULL WHERE corrects_entry_id IS NOT NULL`);
    await transaction.delete(managerLogEntries);
    await transaction.delete(managerLogNumberCounters);
    await transaction.execute(sql`ALTER TABLE manager_log_entries ENABLE TRIGGER manager_log_entries_guard`);
    await transaction.delete(preShiftNotePositions);
    await transaction.delete(preShiftNotes);
  });
}
