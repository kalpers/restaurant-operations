import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  employees,
  orderDiscounts,
  orderItemDiscounts,
  orderItemModifiers,
  orderItems,
  orderItemVoids,
  orders,
  orderSendBatches,
  orderStatusHistory,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { tableNumbersForSessions } from "@/modules/restaurant/queries/session-facts";
import { NotFoundError } from "@/shared/errors/app-error";

import { findOrder } from "../repositories/order-repository";
import { assertPermission } from "../services/access";
import type { OrderStatus, OrderType } from "../types";

// Purpose-built read models for order screens. They carry snapshots as stored, never
// re-resolved from current menu configuration, and no recipe, cost or ledger internals.

export type OrderSummary = {
  id: string;
  orderNumber: number;
  businessDate: string;
  orderType: OrderType;
  status: OrderStatus;
  tableSessionId: string | null;
  tableNumbers: string[];
  customerName: string | null;
  serverName: string | null;
  openedAt: string;
  itemSubtotal: string;
  discountTotal: string;
  subtotal: string;
  draftCount: number;
  sentCount: number;
  version: number;
};

export async function listOrders(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: {
    id?: string;
    status?: OrderStatus;
    tableSessionId?: string;
    orderType?: OrderType;
    businessDate?: string;
  } = {},
): Promise<OrderSummary[]> {
  assertPermission(actor, "orders.view");

  const rows = await executor
    .select({
      order: orders,
      serverFirst: employees.firstName,
      serverLast: employees.lastName,
      draftCount: sql<number>`(SELECT count(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} AND ${orderItems.status} = 'DRAFT')`,
      sentCount: sql<number>`(SELECT count(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} AND ${orderItems.status} = 'SUBMITTED')`,
    })
    .from(orders)
    .leftJoin(employees, eq(employees.id, orders.assignedServerEmployeeId))
    .where(
      and(
        eq(orders.organizationId, actor.organizationId),
        eq(orders.locationId, actor.locationId),
        filter.id ? eq(orders.id, filter.id) : undefined,
        filter.status ? eq(orders.status, filter.status) : undefined,
        filter.tableSessionId ? eq(orders.tableSessionId, filter.tableSessionId) : undefined,
        filter.orderType ? eq(orders.orderType, filter.orderType) : undefined,
        filter.businessDate ? eq(orders.businessDate, filter.businessDate) : undefined,
      ),
    )
    .orderBy(desc(orders.openedAt))
    .limit(200);
  const tables = await tableNumbersForSessions(
    executor,
    [...new Set(rows.flatMap((row) => (row.order.tableSessionId ? [row.order.tableSessionId] : [])))],
  );

  return rows.map(({ order, serverFirst, serverLast, draftCount, sentCount }) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    businessDate: order.businessDate,
    orderType: order.orderType as OrderType,
    status: order.status as OrderStatus,
    tableSessionId: order.tableSessionId,
    tableNumbers: order.tableSessionId ? (tables.get(order.tableSessionId) ?? []) : [],
    customerName: order.customerName,
    serverName: serverFirst ? `${serverFirst} ${serverLast ?? ""}`.trim() : null,
    openedAt: order.openedAt.toISOString(),
    itemSubtotal: order.itemSubtotal,
    discountTotal: order.discountTotal,
    subtotal: order.subtotal,
    draftCount,
    sentCount,
    version: order.version,
  }));
}

export type OrderDetail = OrderSummary & {
  voidedAt: string | null;
  voidReason: string | null;
  items: {
    id: string;
    status: string;
    menuItemId: string;
    name: string;
    code: string;
    quantity: number;
    basePrice: string;
    modifierTotal: string;
    unitPrice: string;
    lineTotal: string;
    specialInstructions: string | null;
    kitchenInstructions: string | null;
    batchNumber: number | null;
    submittedAt: string | null;
    voidedAt: string | null;
    voidReason: string | null;
    voidDisposition: string | null;
    modifiers: {
      modifierGroupId: string;
      modifierId: string;
      groupName: string;
      name: string;
      priceAdjustment: string;
    }[];
    discounts: AppliedDiscount[];
  }[];
  discounts: AppliedDiscount[];
  batches: { id: string; batchNumber: number; sentAt: string; itemCount: number }[];
  history: { status: string; reason: string | null; occurredAt: string }[];
};

export type AppliedDiscount = {
  id: string;
  name: string;
  code: string;
  discountType: string;
  value: string;
  isComp: boolean;
  reason: string;
  appliedAmount: string;
  status: string;
  appliedAt: string;
};

function toDiscount(row: typeof orderDiscounts.$inferSelect | typeof orderItemDiscounts.$inferSelect): AppliedDiscount {
  return {
    id: row.id,
    name: row.nameSnapshot,
    code: row.codeSnapshot,
    discountType: row.discountTypeSnapshot,
    value: row.valueSnapshot,
    isComp: row.isComp,
    reason: row.reason,
    appliedAmount: row.appliedAmount,
    status: row.status,
    appliedAt: row.appliedAt.toISOString(),
  };
}

export async function getOrderDetail(
  executor: DatabaseExecutor,
  actor: Actor,
  orderId: string,
): Promise<OrderDetail> {
  assertPermission(actor, "orders.view");

  const order = await findOrder(executor, actor, orderId);

  if (!order) {
    throw new NotFoundError("order");
  }

  const [summary] = await listOrders(executor, actor, { id: orderId });
  const items = await executor
    .select({ item: orderItems, batchNumber: orderSendBatches.batchNumber, disposition: orderItemVoids.disposition })
    .from(orderItems)
    .leftJoin(orderSendBatches, eq(orderSendBatches.id, orderItems.sendBatchId))
    .leftJoin(orderItemVoids, eq(orderItemVoids.orderItemId, orderItems.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const itemIds = items.map(({ item }) => item.id);
  const [modifierRows, itemDiscountRows, orderDiscountRows, batches, history] = await Promise.all([
    itemIds.length === 0
      ? []
      : executor
          .select()
          .from(orderItemModifiers)
          .where(inArray(orderItemModifiers.orderItemId, itemIds))
          .orderBy(asc(orderItemModifiers.sortOrder)),
    itemIds.length === 0
      ? []
      : executor
          .select()
          .from(orderItemDiscounts)
          .where(inArray(orderItemDiscounts.orderItemId, itemIds))
          .orderBy(asc(orderItemDiscounts.sequence)),
    executor
      .select()
      .from(orderDiscounts)
      .where(eq(orderDiscounts.orderId, orderId))
      .orderBy(asc(orderDiscounts.sequence)),
    executor
      .select()
      .from(orderSendBatches)
      .where(eq(orderSendBatches.orderId, orderId))
      .orderBy(asc(orderSendBatches.batchNumber)),
    executor
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(asc(orderStatusHistory.occurredAt)),
  ]);

  return {
    ...summary!,
    voidedAt: order.voidedAt?.toISOString() ?? null,
    voidReason: order.voidReason,
    items: items.map(({ item, batchNumber, disposition }) => ({
      id: item.id,
      status: item.status,
      menuItemId: item.menuItemId,
      name: item.menuItemNameSnapshot,
      code: item.menuItemCodeSnapshot,
      quantity: item.quantity,
      basePrice: item.basePriceSnapshot,
      modifierTotal: item.modifierTotalSnapshot,
      unitPrice: item.unitPriceSnapshot,
      lineTotal: item.lineTotalSnapshot,
      specialInstructions: item.specialInstructions,
      kitchenInstructions: item.kitchenInstructionsSnapshot,
      batchNumber: batchNumber ?? null,
      submittedAt: item.submittedAt?.toISOString() ?? null,
      voidedAt: item.voidedAt?.toISOString() ?? null,
      voidReason: item.voidReason,
      voidDisposition: disposition ?? null,
      modifiers: modifierRows
        .filter((row) => row.orderItemId === item.id)
        .map((row) => ({
          modifierGroupId: row.modifierGroupId,
          modifierId: row.modifierId,
          groupName: row.modifierGroupNameSnapshot,
          name: row.modifierNameSnapshot,
          priceAdjustment: row.priceAdjustmentSnapshot,
        })),
      discounts: itemDiscountRows.filter((row) => row.orderItemId === item.id).map(toDiscount),
    })),
    discounts: orderDiscountRows.map(toDiscount),
    batches: batches.map((batch) => ({
      id: batch.id,
      batchNumber: batch.batchNumber,
      sentAt: batch.sentAt.toISOString(),
      itemCount: batch.itemCount,
    })),
    history: history.map((entry) => ({
      status: entry.status,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  };
}
