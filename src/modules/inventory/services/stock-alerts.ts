import { and, eq } from "drizzle-orm";

import {
  inventoryItemLocations,
  inventoryItems,
  inventoryStockAlerts,
  notifications,
  unitsOfMeasure,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents, type OutboxEventInput } from "@/infrastructure/outbox/outbox";
import { findUserIdsHolding } from "@/modules/auth/services/permission-holders";

import { alertCrossing } from "../rules/stock-alerts";

// Phase 19 low-stock alerts (policies 11-13). Called by the posting service after it updates
// a balance, inside the same transaction and under the same balance lock, so two postings for
// one item can't both open an alert. Opening one notifies, in-app, every active user at the
// location who holds `purchasing.manage` (decision D6). No cost is ever included.

export const ALERT_RECIPIENT_PERMISSION = "purchasing.manage" as const;

export async function applyStockAlert(
  transaction: DatabaseTransaction,
  posting: {
    organizationId: string;
    locationId: string;
    inventoryItemId: string;
    quantityBefore: string;
    quantityAfter: string;
    transactionId: string;
    occurredAt: Date;
  },
): Promise<void> {
  const [config] = await transaction
    .select({ reorderLevel: inventoryItemLocations.reorderLevel })
    .from(inventoryItemLocations)
    .where(
      and(
        eq(inventoryItemLocations.inventoryItemId, posting.inventoryItemId),
        eq(inventoryItemLocations.locationId, posting.locationId),
      ),
    );
  const crossing = alertCrossing(posting.quantityBefore, posting.quantityAfter, config?.reorderLevel ?? null);

  if (crossing === "NONE") {
    return;
  }

  const [open] = await transaction
    .select({ id: inventoryStockAlerts.id })
    .from(inventoryStockAlerts)
    .where(
      and(
        eq(inventoryStockAlerts.locationId, posting.locationId),
        eq(inventoryStockAlerts.inventoryItemId, posting.inventoryItemId),
        eq(inventoryStockAlerts.status, "OPEN"),
      ),
    );

  if (crossing === "RESOLVE") {
    if (open) {
      await transaction
        .update(inventoryStockAlerts)
        .set({
          status: "RESOLVED",
          resolvedAt: posting.occurredAt,
          quantityWhenResolved: posting.quantityAfter,
          resolvedByTransactionId: posting.transactionId,
          updatedAt: new Date(),
        })
        .where(eq(inventoryStockAlerts.id, open.id));
    }

    return;
  }

  if (open) {
    return;
  }

  const [alert] = await transaction
    .insert(inventoryStockAlerts)
    .values({
      organizationId: posting.organizationId,
      locationId: posting.locationId,
      inventoryItemId: posting.inventoryItemId,
      quantityWhenOpened: posting.quantityAfter,
      reorderLevelWhenOpened: config!.reorderLevel!,
      openedAt: posting.occurredAt,
      openedByTransactionId: posting.transactionId,
    })
    .returning({ id: inventoryStockAlerts.id });
  const recipients = await findUserIdsHolding(transaction, {
    organizationId: posting.organizationId,
    locationId: posting.locationId,
    permission: ALERT_RECIPIENT_PERMISSION,
  });

  if (recipients.length === 0) {
    return;
  }

  const [item] = await transaction
    .select({ name: inventoryItems.name, unitCode: unitsOfMeasure.code })
    .from(inventoryItems)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryItems.baseUnitId))
    .where(eq(inventoryItems.id, posting.inventoryItemId));
  const created = await transaction
    .insert(notifications)
    .values(
      recipients.map((recipientUserId) => ({
        organizationId: posting.organizationId,
        locationId: posting.locationId,
        recipientUserId,
        notificationType: "INVENTORY_LOW",
        title: `Low stock: ${item!.name}`,
        body: `${posting.quantityAfter} ${item!.unitCode} on hand, at or below the reorder level of ${config!.reorderLevel} ${item!.unitCode}.`,
        inventoryStockAlertId: alert!.id,
        createdAt: posting.occurredAt,
      })),
    )
    .returning({ id: notifications.id, recipientUserId: notifications.recipientUserId });
  const events: OutboxEventInput[] = created.map((row) => ({
    organizationId: posting.organizationId,
    locationId: posting.locationId,
    eventType: "notification.created",
    aggregateType: "notification",
    aggregateId: row.id,
    recipientUserId: row.recipientUserId,
    payload: { notificationType: "INVENTORY_LOW", inventoryStockAlertId: alert!.id },
    occurredAt: posting.occurredAt,
  }));

  await writeOutboxEvents(transaction, events);
}
