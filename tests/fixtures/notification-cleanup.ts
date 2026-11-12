import { sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db";

/**
 * Notifications can't be deleted (the guard trigger), and Phase 20 notifications reference
 * schedule periods, swaps, time off, certifications and time entries with RESTRICT. Test
 * cleanups call this before deleting those rows: it lifts the guard for its own transaction,
 * deletes the matching notifications and restores it.
 */
export async function clearNotificationsWhere(database: Database, where: SQL): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`ALTER TABLE notifications DISABLE TRIGGER notifications_guard_trigger`);
    await transaction.execute(sql`DELETE FROM notifications WHERE ${where}`);
    await transaction.execute(sql`ALTER TABLE notifications ENABLE TRIGGER notifications_guard_trigger`);
  });
}

/** Every notification of a Phase 20 kind, for whole-table test cleanups. */
export function clearPhase20Notifications(database: Database): Promise<void> {
  return clearNotificationsWhere(
    database,
    sql`schedule_period_id IS NOT NULL OR shift_swap_request_id IS NOT NULL OR time_off_request_id IS NOT NULL
        OR employee_certification_id IS NOT NULL OR time_entry_id IS NOT NULL`,
  );
}

const uuids = (ids: readonly string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/** Notifications sent to these users, or linked to these employees' records. */
export async function clearNotificationsFor(
  database: Database,
  scope: { userIds?: readonly string[]; employeeIds?: readonly string[]; schedulePeriodIds?: readonly string[] },
): Promise<void> {
  const parts: SQL[] = [];

  if (scope.userIds?.length) {
    parts.push(sql`recipient_user_id = ANY(${uuids(scope.userIds)})`);
  }

  if (scope.schedulePeriodIds?.length) {
    parts.push(sql`schedule_period_id = ANY(${uuids(scope.schedulePeriodIds)})`);
  }

  if (scope.employeeIds?.length) {
    const employees = uuids(scope.employeeIds);

    parts.push(sql`time_off_request_id IN (SELECT id FROM time_off_requests WHERE employee_id = ANY(${employees}))`);
    parts.push(sql`employee_certification_id IN (SELECT id FROM employee_certifications WHERE employee_id = ANY(${employees}))`);
    parts.push(sql`time_entry_id IN (SELECT id FROM time_entries WHERE employee_id = ANY(${employees}))`);
    parts.push(
      sql`shift_swap_request_id IN (SELECT id FROM shift_swap_requests WHERE requesting_employee_id = ANY(${employees}) OR target_employee_id = ANY(${employees}))`,
    );
  }

  if (parts.length === 0) {
    return;
  }

  await clearNotificationsWhere(database, sql.join(parts, sql` OR `));

  // Their `notification.created` outbox events name the recipient, which a user delete needs gone.
  if (scope.userIds?.length) {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`ALTER TABLE outbox_events DISABLE TRIGGER outbox_events_guard_trigger`);
      await transaction.execute(sql`DELETE FROM outbox_events WHERE recipient_user_id = ANY(${uuids(scope.userIds!)})`);
      await transaction.execute(sql`ALTER TABLE outbox_events ENABLE TRIGGER outbox_events_guard_trigger`);
    });
  }
}
