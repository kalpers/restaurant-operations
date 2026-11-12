import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { findUserIdsHolding } from "@/modules/auth/services/permission-holders";
import { findCertificationsInWarningWindow } from "@/modules/employees/queries/certification-warnings";
import { findEmployeeDisplayNames, findLinkedUserIds } from "@/modules/employees/queries/employee-display-names";
import { createNotifications, type NewNotification } from "@/modules/notifications/notification-writer";
import { listActiveLocations } from "@/modules/organization/services/organization-service";
import { findTimeClockSignals } from "@/modules/scheduling/services/timeclock-service";
import { localDateOf } from "@/shared/time/zoned-time";

// Phase 20 (policy 14, D11 and D12): notifications that depend on time passing rather than on
// a write. The maintenance runner calls this every run (hourly by default) under its advisory
// lock. Each notification has a dedupe key, so running it again sends nothing new:
// - CERTIFICATION_EXPIRING once per certification and expiration date, to the employee and to
//   `hr.certifications.manage` holders at the location;
// - OVERTIME_APPROACHING once per employee and work week, to the employee and to
//   `timeclock.manage` holders;
// - MISSED_CLOCK_OUT once per entry, to `timeclock.manage` holders.
// Each location runs in its own transaction. Warnings never block a punch (Phase 18).

export type TimeBasedSignalsResult = { locations: number; notificationsCreated: number };

export async function notifyTimeBasedSignals(
  database: Database,
  now: Date = new Date(),
  options: { locationIds?: readonly string[] } = {},
): Promise<TimeBasedSignalsResult> {
  const locations = (await listActiveLocations(database)).filter(
    (location) => !options.locationIds || options.locationIds.includes(location.id),
  );
  let notificationsCreated = 0;

  for (const location of locations) {
    notificationsCreated += await withTransaction(database, async (transaction) => {
      const scope = { organizationId: location.organizationId, locationId: location.id };
      const holders = (permission: "hr.certifications.manage" | "timeclock.manage") =>
        findUserIdsHolding(transaction, { ...scope, permission });
      const today = localDateOf(now, location.timeZone);
      const certifications = await findCertificationsInWarningWindow(transaction, { ...scope, today });
      const clock = await findTimeClockSignals(transaction, scope, now);
      const employeeIds = [
        ...certifications.map((row) => row.employeeId),
        ...clock.approaching.map((row) => row.employeeId),
        ...clock.missedClockOuts.map((row) => row.employeeId),
      ];
      const names = await findEmployeeDisplayNames(transaction, { organizationId: location.organizationId, employeeIds });
      const users = await findLinkedUserIds(transaction, { organizationId: location.organizationId, employeeIds });
      const name = (employeeId: string) => names.get(employeeId) ?? "An employee";
      const certManagers = certifications.length > 0 ? await holders("hr.certifications.manage") : [];
      const clockManagers =
        clock.approaching.length + clock.missedClockOuts.length > 0 ? await holders("timeclock.manage") : [];
      const pending: NewNotification[] = [];

      for (const row of certifications) {
        const dedupeKey = `cert:${row.certificationId}:${row.expirationDate}`;
        const links = { employeeCertificationId: row.certificationId };
        const own = users.get(row.employeeId);

        if (own) {
          pending.push({
            type: "CERTIFICATION_EXPIRING",
            recipientUserId: own,
            title: `${row.typeName} expires soon`,
            body: `Your ${row.typeName} expires on ${row.expirationDate}. Renew it and give a manager the new one.`,
            links,
            dedupeKey,
          });
        }

        for (const recipientUserId of certManagers.filter((id) => id !== own)) {
          pending.push({
            type: "CERTIFICATION_EXPIRING",
            recipientUserId,
            title: `Certification expiring: ${name(row.employeeId)}`,
            body: `${name(row.employeeId)}'s ${row.typeName} expires on ${row.expirationDate}.`,
            links,
            dedupeKey,
          });
        }
      }

      for (const row of clock.approaching) {
        const dedupeKey = `overtime:${row.employeeId}:${row.weekStart}`;
        const links = { timeEntryId: row.entryId };
        const own = users.get(row.employeeId);
        const words = row.state === "OVERTIME" ? "is in overtime" : "is close to overtime";

        if (own) {
          pending.push({
            type: "OVERTIME_APPROACHING",
            recipientUserId: own,
            title: row.state === "OVERTIME" ? "You're in overtime this week" : "You're close to overtime",
            body: `Your hours for the week starting ${row.weekStart} are near or past the overtime line. Check with your manager.`,
            links,
            dedupeKey,
          });
        }

        for (const recipientUserId of clockManagers.filter((id) => id !== own)) {
          pending.push({
            type: "OVERTIME_APPROACHING",
            recipientUserId,
            title: `Overtime: ${name(row.employeeId)}`,
            body: `${name(row.employeeId)} ${words} for the week starting ${row.weekStart}.`,
            links,
            dedupeKey,
          });
        }
      }

      for (const row of clock.missedClockOuts) {
        for (const recipientUserId of clockManagers) {
          pending.push({
            type: "MISSED_CLOCK_OUT",
            recipientUserId,
            title: `Missed clock-out: ${name(row.employeeId)}`,
            body: `${name(row.employeeId)} is still clocked in from ${row.businessDate}. Close the entry with an adjustment on the time clock.`,
            links: { timeEntryId: row.entryId },
            dedupeKey: `missed:${row.entryId}`,
          });
        }
      }

      return createNotifications(transaction, { ...scope, at: now }, pending);
    });
  }

  return { locations: locations.length, notificationsCreated };
}
