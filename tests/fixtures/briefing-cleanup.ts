import { sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  managerLogCategories,
  freeTextRedactions,
  managerLogEntries,
  managerLogNumberCounters,
  preShiftNotePositions,
  preShiftNotes,
} from "@/db/schema";

/**
 * Phase 32: every manager log entry and pre-shift note. The log is append-only, so its guard
 * is lifted for this transaction only (test database). They reference users, employees,
 * positions and locations, so this runs before those are cleared.
 *
 * Phase 33: categories reference the users who changed them and can't be deleted, so their
 * guard is lifted too; the category service puts the defaults back on first use.
 */
export async function clearBriefingData(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`ALTER TABLE manager_log_entries DISABLE TRIGGER manager_log_entries_guard`);
    await transaction.execute(sql`UPDATE manager_log_entries SET corrects_entry_id = NULL WHERE corrects_entry_id IS NOT NULL`);
    await transaction.delete(managerLogEntries);
    await transaction.delete(managerLogNumberCounters);
    await transaction.execute(sql`ALTER TABLE manager_log_entries ENABLE TRIGGER manager_log_entries_guard`);
    await transaction.execute(sql`ALTER TABLE manager_log_categories DISABLE TRIGGER manager_log_categories_guard`);
    await transaction.delete(managerLogCategories);
    await transaction.execute(sql`ALTER TABLE manager_log_categories ENABLE TRIGGER manager_log_categories_guard`);
    await transaction.delete(preShiftNotePositions);
    await transaction.delete(preShiftNotes);
    // Phase 34: redaction records reference users and organizations and are append-only.
    await transaction.execute(sql`ALTER TABLE free_text_redactions DISABLE TRIGGER free_text_redactions_append_only_trigger`);
    await transaction.delete(freeTextRedactions);
    await transaction.execute(sql`ALTER TABLE free_text_redactions ENABLE TRIGGER free_text_redactions_append_only_trigger`);
  });
}
