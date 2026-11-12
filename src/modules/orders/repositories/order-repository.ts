import { and, eq, inArray, sql } from "drizzle-orm";

import {
  locations,
  locationSettings,
  orderDiscounts,
  orderItemDiscounts,
  orderItems,
  orderItemShares,
  orderItemStatusHistory,
  orders,
  orderStatusHistory,
  orderTaxLines,
} from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { readConstraintName } from "@/db/helpers/database-errors";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { subtractDecimals, toScale } from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";

import { calculateOrderTax } from "../rules/order-tax";
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
      taxEnabled: locationSettings.taxEnabled,
      cashDrawerRequired: locationSettings.cashDrawerRequired,
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
 * Locks the order row without a version check, for work that doesn't change the order but
 * must serialize with every change to it (Phase 11 settlement commands).
 */
export async function lockOrderRow(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
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

  return row;
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
 * snapshots and the immutable discount snapshots, then the tax from the items' tax
 * snapshots (Phase 17), stores the projections (`order_tax_lines` is rewritten) and bumps
 * the order version. Called by every change that can move the eligible subtotal.
 */
export async function recomputeAndBumpOrder(
  transaction: DatabaseTransaction,
  orderId: string,
  values: Partial<typeof orders.$inferInsert> = {},
): Promise<OrderRow> {
  const ownItems = await transaction
    .select({
      id: orderItems.id,
      status: orderItems.status,
      lineTotal: orderItems.lineTotalSnapshot,
      taxCategoryId: orderItems.taxCategoryId,
      taxCategoryCode: orderItems.taxCategoryCodeSnapshot,
      taxRate: orderItems.taxRateSnapshot,
      taxIncluded: orderItems.taxIncludedSnapshot,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  // Phase 20 (policy 17): a SPLIT item counts through its ACTIVE shares, which may sit on other
  // checks. Each share is a line of its own amount with the original's tax snapshot.
  const shares = await transaction
    .select({
      id: orderItemShares.id,
      lineTotal: orderItemShares.amount,
      taxCategoryId: orderItemShares.taxCategoryId,
      taxCategoryCode: orderItemShares.taxCategoryCodeSnapshot,
      taxRate: orderItemShares.taxRateSnapshot,
      taxIncluded: orderItemShares.taxIncludedSnapshot,
    })
    .from(orderItemShares)
    .where(and(eq(orderItemShares.orderId, orderId), eq(orderItemShares.status, "ACTIVE")));
  const items = [...ownItems, ...shares.map((share) => ({ ...share, status: "SUBMITTED" }))];
  // Phase 20 (policy 16): an exemption set or cleared in this change, or the order's own.
  const [current] = await transaction
    .select({ taxExempt: orders.taxExempt })
    .from(orders)
    .where(eq(orders.id, orderId));
  const exempt = values.taxExempt ?? current?.taxExempt ?? false;
  const itemIds = ownItems.map((item) => item.id);
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

  const tax = calculateOrderTax({
    items: items.filter((item) => item.status === "SUBMITTED"),
    itemNetAmounts: totals.itemNetAmounts,
    orderDiscountAmount: totals.orderDiscountAmount,
    exempt,
  });

  await transaction.delete(orderTaxLines).where(eq(orderTaxLines.orderId, orderId));

  if (tax.lines.length > 0) {
    await transaction.insert(orderTaxLines).values(
      tax.lines.map((line) => ({
        orderId,
        taxCategoryId: line.taxCategoryId,
        taxCategoryCodeSnapshot: line.taxCategoryCode,
        taxRateSnapshot: line.taxRate,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        taxIncluded: line.taxIncluded,
      })),
    );
  }

  const [updated] = await transaction
    .update(orders)
    .set({
      ...values,
      itemSubtotal: totals.itemSubtotal,
      discountTotal: totals.discountTotal,
      // Phase 20 (D14): tax inside the prices comes off, so the subtotal stays pre-tax.
      subtotal: toScale(subtractDecimals(totals.subtotal, tax.includedTaxTotal), 2),
      includedTaxTotal: tax.includedTaxTotal,
      taxTotal: tax.taxTotal,
      version: sql`${orders.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId))
    .returning()
    .catch((error: unknown) => {
      throw mapSettlementGuard(error);
    });

  return updated!;
}

/**
 * While a Settlement is OPEN, the order's amount and status are locked (database trigger,
 * Phase 11), so its amount snapshot can't go stale. Draft edits don't move the amount.
 */
export function mapSettlementGuard(error: unknown): unknown {
  switch (readConstraintName(error)) {
    case "orders_settlement_in_progress":
      return new BusinessRuleError(
        "SETTLEMENT_IN_PROGRESS",
        "This order is being settled. Cancel the settlement to change the check.",
      );
    case "orders_closed_frozen":
      return new BusinessRuleError("ORDER_NOT_OPEN", "This order is closed.");
    default:
      return error;
  }
}

/**
 * OPEN -> CLOSED. Called only by the close-order workflow, inside the transaction that
 * completes the order's Settlement; a database trigger refuses closure without a COMPLETED
 * settlement for this amount. There is no other close operation.
 */
export async function closeOrderForSettlement(
  transaction: DatabaseTransaction,
  entry: { orderId: string; settlementId: string; userId: string; at: Date },
): Promise<OrderRow> {
  const [updated] = await transaction
    .update(orders)
    .set({ status: "CLOSED", closedAt: entry.at, version: sql`${orders.version} + 1`, updatedAt: entry.at })
    .where(and(eq(orders.id, entry.orderId), eq(orders.status, "OPEN")))
    .returning();

  if (!updated) {
    throw new BusinessRuleError("ORDER_NOT_OPEN", "This order is no longer open.");
  }

  await appendOrderHistory(transaction, {
    orderId: entry.orderId,
    status: "CLOSED",
    reason: `Settlement ${entry.settlementId} completed`,
    userId: entry.userId,
    at: entry.at,
  });

  return updated;
}

/** DRAFT items still on an order. Settlement completion needs none. */
export async function countDraftItems(executor: DatabaseExecutor, orderId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, "DRAFT")));

  return row?.count ?? 0;
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
