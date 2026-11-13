import { and, eq, inArray } from "drizzle-orm";

import { notifications, userRoles, users } from "@/db/schema";
import type { NotificationType } from "@/db/schema/notifications";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";

// Phase 20 (policies 12-14): the one writer for the scheduling, time-off, certification and
// time-clock notifications. It runs inside the caller's transaction, so a notification exists
// only if the change it reports commits, and its `notification.created` realtime event goes
// out after commit through the outbox. Recipients must be active users with an active role at
// the location. Bodies never hold compensation or restricted HR data (the callers' job).

export type NotificationLinks = {
  schedulePeriodId?: string;
  shiftSwapRequestId?: string;
  timeOffRequestId?: string;
  employeeCertificationId?: string;
  timeEntryId?: string;
  inventoryLotId?: string;
};

export type NewNotification = {
  type: NotificationType;
  recipientUserId: string;
  title: string;
  body: string;
  links: NotificationLinks;
  /** One notification per key and recipient: a second write with the same key is skipped. */
  dedupeKey?: string;
};

/** The given users who are active and hold an active role at the location. */
export async function activeUsersAtLocation(
  executor: DatabaseExecutor,
  input: { locationId: string; userIds: readonly (string | null | undefined)[] },
): Promise<Set<string>> {
  const ids = [...new Set(input.userIds.filter((id): id is string => typeof id === "string"))];

  if (ids.length === 0) {
    return new Set();
  }

  const rows = await executor
    .selectDistinct({ userId: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(
      and(
        inArray(users.id, ids),
        eq(users.active, true),
        eq(userRoles.active, true),
        eq(userRoles.locationId, input.locationId),
      ),
    );

  return new Set(rows.map((row) => row.userId));
}

/** Writes the notifications whose recipient may receive them here; returns how many. */
export async function createNotifications(
  transaction: DatabaseTransaction,
  context: { organizationId: string; locationId: string; at: Date },
  inputs: readonly NewNotification[],
): Promise<number> {
  const allowed = await activeUsersAtLocation(transaction, {
    locationId: context.locationId,
    userIds: inputs.map((input) => input.recipientUserId),
  });
  const seen = new Set<string>();
  const rows = inputs.filter((input) => {
    const key = `${input.type}|${input.recipientUserId}|${input.dedupeKey ?? JSON.stringify(input.links)}`;

    if (!allowed.has(input.recipientUserId) || seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  if (rows.length === 0) {
    return 0;
  }

  const created = await transaction
    .insert(notifications)
    .values(
      rows.map((input) => ({
        organizationId: context.organizationId,
        locationId: context.locationId,
        recipientUserId: input.recipientUserId,
        notificationType: input.type,
        title: input.title,
        body: input.body,
        dedupeKey: input.dedupeKey ?? null,
        createdAt: context.at,
        ...input.links,
      })),
    )
    .onConflictDoNothing({ target: [notifications.dedupeKey, notifications.recipientUserId] })
    .returning({
      id: notifications.id,
      recipientUserId: notifications.recipientUserId,
      notificationType: notifications.notificationType,
    });

  await writeOutboxEvents(
    transaction,
    created.map((row) => ({
      organizationId: context.organizationId,
      locationId: context.locationId,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: row.id,
      recipientUserId: row.recipientUserId,
      payload: { notificationType: row.notificationType },
      occurredAt: context.at,
    })),
  );

  return created.length;
}
