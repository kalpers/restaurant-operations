import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findLinkedUserIds } from "@/modules/employees/queries/employee-display-names";
import { createNotifications } from "@/modules/notifications/notification-writer";

// Phase 20 (policy 13, D10): the scheduling notifications, written in the transaction of the
// change they report. Recipients are employees with an active linked user at the location.
// Bodies name dates only: no pay, hours totals or HR details.

const context = (actor: Actor) => ({
  organizationId: actor.organizationId,
  locationId: actor.locationId,
  at: new Date(),
});

export async function notifySchedulePublished(
  transaction: DatabaseTransaction,
  actor: Actor,
  period: { id: string; name: string; startDate: string; endDate: string },
  employeeIds: readonly string[],
): Promise<void> {
  const users = await findLinkedUserIds(transaction, { organizationId: actor.organizationId, employeeIds });

  await createNotifications(
    transaction,
    context(actor),
    [...new Set(users.values())].map((recipientUserId) => ({
      type: "SCHEDULE_PUBLISHED",
      recipientUserId,
      title: `Schedule published: ${period.name}`,
      body: `Your shifts for ${period.startDate} to ${period.endDate} are on My schedule.`,
      links: { schedulePeriodId: period.id },
    })),
  );
}

export async function notifyShiftSwapped(
  transaction: DatabaseTransaction,
  actor: Actor,
  swap: { id: string; requestingEmployeeId: string; targetEmployeeId: string },
  shift: { shiftDate: string },
): Promise<void> {
  const users = await findLinkedUserIds(transaction, {
    organizationId: actor.organizationId,
    employeeIds: [swap.requestingEmployeeId, swap.targetEmployeeId],
  });
  const message = (employeeId: string) =>
    employeeId === swap.requestingEmployeeId
      ? `Your shift on ${shift.shiftDate} was swapped away. It's no longer on your schedule.`
      : `The shift on ${shift.shiftDate} you accepted is now on your schedule.`;

  await createNotifications(
    transaction,
    context(actor),
    [swap.requestingEmployeeId, swap.targetEmployeeId].flatMap((employeeId) => {
      const recipientUserId = users.get(employeeId);

      return recipientUserId
        ? [
            {
              type: "SHIFT_CHANGED" as const,
              recipientUserId,
              title: `Shift swap approved: ${shift.shiftDate}`,
              body: message(employeeId),
              links: { shiftSwapRequestId: swap.id },
            },
          ]
        : [];
    }),
  );
}

export async function notifyTimeOffDecided(
  transaction: DatabaseTransaction,
  actor: Actor,
  request: { id: string; employeeId: string; startAt: Date; endAt: Date },
  status: "APPROVED" | "DENIED",
  dates: { from: string; to: string },
): Promise<void> {
  const users = await findLinkedUserIds(transaction, {
    organizationId: actor.organizationId,
    employeeIds: [request.employeeId],
  });
  const recipientUserId = users.get(request.employeeId);

  if (!recipientUserId) {
    return;
  }

  const span = dates.from === dates.to ? dates.from : `${dates.from} to ${dates.to}`;

  await createNotifications(transaction, context(actor), [
    {
      type: status === "APPROVED" ? "TIME_OFF_APPROVED" : "TIME_OFF_DENIED",
      recipientUserId,
      title: status === "APPROVED" ? "Time off approved" : "Time off denied",
      body: `Your request for ${span} was ${status === "APPROVED" ? "approved" : "denied"}. See My schedule for the manager's note.`,
      links: { timeOffRequestId: request.id },
    },
  ]);
}
