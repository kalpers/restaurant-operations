import { isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  checklistRunItems,
  checklistRuns,
  checklistTemplateItems,
  checklistTemplatePositions,
  checklistTemplates,
  managerLogCategories,
  notifications,
  temperaturePoints,
  temperatureReadings,
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
    // Phase 36: checklists reference users, employees, positions and locations, and their
    // guards refuse deletes.
    await transaction.execute(sql`ALTER TABLE checklist_run_items DISABLE TRIGGER checklist_run_items_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_runs DISABLE TRIGGER checklist_runs_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_template_items DISABLE TRIGGER checklist_template_items_no_delete_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_templates DISABLE TRIGGER checklist_templates_no_delete_trigger`);
    await transaction.delete(checklistRunItems);
    await transaction.delete(checklistRuns);
    await transaction.delete(checklistTemplateItems);
    await transaction.delete(checklistTemplatePositions);
    await transaction.delete(checklistTemplates);
    await transaction.execute(sql`ALTER TABLE checklist_run_items ENABLE TRIGGER checklist_run_items_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_runs ENABLE TRIGGER checklist_runs_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_template_items ENABLE TRIGGER checklist_template_items_no_delete_trigger`);
    await transaction.execute(sql`ALTER TABLE checklist_templates ENABLE TRIGGER checklist_templates_no_delete_trigger`);
    // Phase 36 part 2: readings are append-only and points can't be deleted; out-of-range
    // notifications reference readings.
    await transaction.execute(sql`ALTER TABLE notifications DISABLE TRIGGER notifications_guard_trigger`);
    await transaction.delete(notifications).where(isNotNull(notifications.temperatureReadingId));
    await transaction.execute(sql`ALTER TABLE notifications ENABLE TRIGGER notifications_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE temperature_readings DISABLE TRIGGER temperature_readings_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE temperature_points DISABLE TRIGGER temperature_points_no_delete_trigger`);
    await transaction.update(temperatureReadings).set({ correctsReadingId: null, followsUpReadingId: null });
    await transaction.delete(temperatureReadings);
    await transaction.delete(temperaturePoints);
    await transaction.execute(sql`ALTER TABLE temperature_readings ENABLE TRIGGER temperature_readings_guard_trigger`);
    await transaction.execute(sql`ALTER TABLE temperature_points ENABLE TRIGGER temperature_points_no_delete_trigger`);
    // Phase 34: redaction records reference users and organizations and are append-only.
    await transaction.execute(sql`ALTER TABLE free_text_redactions DISABLE TRIGGER free_text_redactions_append_only_trigger`);
    await transaction.delete(freeTextRedactions);
    await transaction.execute(sql`ALTER TABLE free_text_redactions ENABLE TRIGGER free_text_redactions_append_only_trigger`);
  });
}
