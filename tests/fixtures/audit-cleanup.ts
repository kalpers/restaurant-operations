import { inArray, or, type SQL } from "drizzle-orm";

import type { Database } from "@/db";
import { auditEvents } from "@/db/schema";

/**
 * The audit trail is append-only and references users, employees and locations with
 * RESTRICT, so test teardown that deletes those rows first removes their audit events,
 * with the append-only trigger disabled for that one transaction. With no scope it
 * clears the whole trail (integration files run one at a time on their own database).
 * Test code only: the application never deletes audit events.
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
    await transaction.execute("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_trigger" as never);

    if (scope) {
      await transaction.delete(auditEvents).where(or(...conditions));
    } else {
      await transaction.delete(auditEvents);
    }

    await transaction.execute("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only_trigger" as never);
  });
}
