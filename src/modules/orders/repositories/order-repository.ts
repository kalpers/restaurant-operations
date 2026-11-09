import { and, eq, inArray, sql } from "drizzle-orm";

import {
  locations,
  locationSettings,
  orderDiscounts,
  orderItemDiscounts,
  orderItems,
  orderItemStatusHistory,
  orders,
  orderStatusHistory,
} from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf } from "@/shared/time/business-date-service";

import { calculateOrderTotals } from "../rules/order-totals";
import type { DiscountType } from "../types";

export type OrderRow = typeof orders.$inferSelect;

/** Location settings an order needs: the business date (from BusinessDateService) and flags. */
export async function readOrderLocation(executor: DatabaseExecutor, locationId: string, at: Date) {
  const [row] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
      allowTakeout: locationSettings.allowTakeout,
      active: locations.active,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return { ...row, businessDate: businessDateOf(at, row) };
}

/** An order at the actor's location, or not found: another location's orders look absent. */
export async function findOrder(executor: DatabaseExecutor, actor: Actor, orderId: string) {
  const [row] = await executor
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.organizationId, actor.organizationId),
        eq(orders.locationId, actor.locationId),
      ),
    );

  return row ?? null;
}

/**
 * Locks the order row for the rest of the transaction and checks the version the client
 * saw. Every order mutation goes through this, so edits, sends, discounts and voids on one
 * order serialize and a stale screen gets a conflict instead of overwriting.
 */
export async function lockOrder(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  expectedVersion: number,
): Promise<OrderRow> {
  const [row] = await transaction
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.organizationId, actor.organizationId),
        eq(orders.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!row) {
    throw new NotFoundError("order");
  }

  if (row.version !== expectedVersion) {
    throw new ConcurrencyError("order", row.id);
  }

  return row;
}

/**
 * Recomputes the pre-tax totals and every applied discount amount from SUBMITTED item
 * snapshots and the immutable discount snapshots, then stores the projection and bumps the
 * order version. Called by every change that can move the eligible subtotal.
 */
export async function recomputeAndBumpOrder(
  transaction: DatabaseTransaction,
  orderId: string,
  values: Partial<typeof orders.$inferInsert> = {},
): Promise<OrderRow> {
  const items = await transaction
    .select({ id: orderItems.id, status: orderItems.status, lineTotal: orderItems.lineTotalSnapshot })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const itemIds = items.map((item) => item.id);
  const itemDiscountRows =
    itemIds.length === 0
      ? []
      : await transaction
          .select()
          .from(orderItemDiscounts)
          .where(and(inArray(orderItemDiscounts.orderItemId, itemIds), eq(orderItemDiscounts.status, "APPLIED")));
  const orderDiscountRows = await transaction
    .select()
    .from(orderDiscounts)
    .where(and(eq(orderDiscounts.orderId, orderId), eq(orderDiscounts.status, "APPLIED")));
  const totals = calculateOrderTotals({
    items,
    itemDiscounts: itemDiscountRows.map((row) => ({
      id: row.id,
      orderItemId: row.orderItemId,
      type: row.discountTypeSnapshot as DiscountType,
      value: row.valueSnapshot,
      sequence: row.sequence,
    })),
    orderDiscounts: orderDiscountRows.map((row) => ({
      id: row.id,
      type: row.discountTypeSnapshot as DiscountType,
      value: row.valueSnapshot,
      sequence: row.sequence,
    })),
  });

  for (const row of itemDiscountRows) {
    const amount = totals.appliedAmounts.get(row.id)!;

    if (amount !== row.appliedAmount) {
      await transaction
        .update(orderItemDiscounts)
        .set({ appliedAmount: amount })
        .where(eq(orderItemDiscounts.id, row.id));
    }
  }

  for (const row of orderDiscountRows) {
    const amount = totals.appliedAmounts.get(row.id)!;

    if (amount !== row.appliedAmount) {
      await transaction
        .update(orderDiscounts)
        .set({ appliedAmount: amount })
        .where(eq(orderDiscounts.id, row.id));
    }
  }

  const [updated] = await transaction
    .update(orders)
    .set({
      ...values,
      itemSubtotal: totals.itemSubtotal,
      discountTotal: totals.discountTotal,
      subtotal: totals.subtotal,
      version: sql`${orders.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId))
    .returning();

  return updated!;
}

export async function appendOrderHistory(
  transaction: DatabaseTransaction,
  entry: { orderId: string; status: string; reason: string | null; userId: string; at: Date },
) {
  await transaction.insert(orderStatusHistory).values({
    orderId: entry.orderId,
    status: entry.status,
    reason: entry.reason,
    changedByUserId: entry.userId,
    occurredAt: entry.at,
  });
}

export async function appendItemHistory(
  transaction: DatabaseTransaction,
  entries: { orderItemId: string; status: string; reason: string | null; userId: string; at: Date }[],
) {
  if (entries.length === 0) {
    return;
  }

  await transaction.insert(orderItemStatusHistory).values(
    entries.map((entry) => ({
      orderItemId: entry.orderItemId,
      status: entry.status,
      reason: entry.reason,
      changedByUserId: entry.userId,
      occurredAt: entry.at,
    })),
  );
}

/** How many OPEN orders reference a session. Completion and cancellation need zero. */
export async function countOpenOrdersForSession(
  executor: DatabaseExecutor,
  tableSessionId: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.tableSessionId, tableSessionId), eq(orders.status, "OPEN")));

  return row?.count ?? 0;
}
