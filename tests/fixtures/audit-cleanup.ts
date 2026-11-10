import { inArray, or, type SQL } from "drizzle-orm";

import type { Database } from "@/db";
import { auditEvents } from "@/db/schema";

/**
 * The audit trail is append-only and references users, employees and locations with
 * RESTRICT, so test teardown that deletes those rows first removes their audit events.
 * With no scope it clears the whole trail (integration files run one at a time).
 *
 * Triggers are skipped with `SET LOCAL session_replication_role = replica`, which lasts
 * only for this transaction and takes no table lock. `ALTER TABLE ... DISABLE TRIGGER`
 * would take an ACCESS EXCLUSIVE lock on a table nearly every action writes to (sign-in
 * included), stalling the other E2E worker. Needs a superuser, as the local and CI test
 * databases are. Test code only: the application never deletes audit events.
 */
export async function clearAuditEvents(
  database: Database,
  scope?: { userIds?: readonly string[]; employeeIds?: readonly string[]; locationIds?: readonly string[] },
): Promise<void> {
  const conditions: SQL[] = [];

  if (scope?.userIds?.length) {
    conditions.push(inArray(auditEvents.actorUserId, [...scope.userIds]));
    conditions.push(inArray(auditEvents.entityId, [...scope.userIds]));
  }

  if (scope?.employeeIds?.length) {
    conditions.push(inArray(auditEvents.actorEmployeeId, [...scope.employeeIds]));
  }

  if (scope?.locationIds?.length) {
    conditions.push(inArray(auditEvents.locationId, [...scope.locationIds]));
  }

  if (scope && conditions.length === 0) {
    return;
  }

  await database.transaction(async (transaction) => {
    await transaction.execute("SET LOCAL session_replication_role = replica" as never);

    if (scope) {
      await transaction.delete(auditEvents).where(or(...conditions));
    } else {
      await transaction.delete(auditEvents);
    }
  });
}
