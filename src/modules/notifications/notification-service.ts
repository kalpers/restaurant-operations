import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { notifications } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";

import { notificationLink, type NotificationLink } from "./notification-links";

// In-app notifications (README section 22). A notification belongs to one recipient at one
// location: only that user can list or mark it, so being the recipient is the authorization
// and no permission code is involved. Kitchen writes the server-ready kinds.

export type NotificationView = {
  id: string;
  type: string;
  title: string;
  body: string;
  orderId: string | null;
  /** Phase 20: where the notification leads, if anywhere the recipient may go. */
  link: NotificationLink | null;
  createdAt: string;
  readAt: string | null;
};

function ownedBy(actor: Actor) {
  return and(
    eq(notifications.recipientUserId, actor.userId),
    eq(notifications.organizationId, actor.organizationId),
    eq(notifications.locationId, actor.locationId),
  );
}

export async function listNotifications(
  executor: DatabaseExecutor,
  actor: Actor,
  limit = 20,
): Promise<{ unreadCount: number; notifications: NotificationView[] }> {
  const rows = await executor
    .select()
    .from(notifications)
    .where(ownedBy(actor))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  const [unread] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(ownedBy(actor), isNull(notifications.readAt)));

  return {
    unreadCount: unread?.count ?? 0,
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.notificationType,
      title: row.title,
      body: row.body,
      orderId: row.orderId,
      link: notificationLink(row.notificationType, row, actor.permissions),
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    })),
  };
}

/** Marks the actor's own notifications read; IDs that aren't theirs are simply not matched. */
export async function markNotificationsRead(
  database: Database,
  actor: Actor,
  input: { ids?: readonly string[]; all?: boolean },
): Promise<{ updated: number }> {
  const scope = input.all
    ? and(ownedBy(actor), isNull(notifications.readAt))
    : and(ownedBy(actor), isNull(notifications.readAt), inArray(notifications.id, [...(input.ids ?? [])]));

  if (!input.all && (input.ids ?? []).length === 0) {
    return { updated: 0 };
  }

  const rows = await database
    .update(notifications)
    .set({ readAt: new Date() })
    .where(scope)
    .returning({ id: notifications.id });

  return { updated: rows.length };
}
