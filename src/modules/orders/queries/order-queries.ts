import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import {
  employees,
  guestParties,
  orderDiscounts,
  orderItemDiscounts,
  orderItemModifiers,
  orderItems,
  orderItemShares,
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
import { loadOrderAllergenView } from "./order-allergens";
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
  /** Post-discount, pre-tax. */
  subtotal: string;
  /** Phase 17: tax on the submitted items. */
  taxTotal: string;
  /** Phase 17: subtotal plus tax, what the guest owes. */
  totalDue: string;
  /** Phase 20 (policy 15): the part of the tax that was inside the prices. */
  includedTaxTotal: string;
  /** Phase 20 (policy 16). The certificate reference isn't shown. */
  taxExempt: boolean;
  taxExemptReason: string | null;
  draftCount: number;
  sentCount: number;
  version: number;
};

export type OrderFilter = {
  id?: string;
  status?: OrderStatus;
  tableSessionId?: string;
  orderType?: OrderType;
  businessDate?: string;
};

export async function listOrders(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: OrderFilter = {},
): Promise<OrderSummary[]> {
  assertPermission(actor, "orders.view");

  return readOrderSummaries(executor, actor, filter);
}

/**
 * Unchecked read for another domain that has already authorized the caller with its own
 * permission (Settlement views use `settlements.view`). Location-scoped like every query.
 */
export async function readOrderSummaries(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: OrderFilter,
): Promise<OrderSummary[]> {

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
    taxTotal: order.taxTotal,
    totalDue: order.totalDue,
    includedTaxTotal: order.includedTaxTotal,
    taxExempt: order.taxExempt,
    taxExemptReason: order.taxExemptReason,
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
    /** Phase 17: the item's course, and its tax rate snapshot (null when untaxed or a draft). */
    courseNumber: number;
    taxRate: string | null;
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
  /**
   * Phase 20 (policy 17): shares of shared items that are on this check, whichever check the
   * item was sent on, and each SPLIT item's shares here or elsewhere (`elsewhere`).
   */
  shares: {
    id: string;
    orderItemId: string;
    itemName: string;
    shareNumber: number;
    shareCount: number;
    amount: string;
    status: string;
    version: number;
    /** The check holding the share, when it isn't this one. */
    elsewhereOrderNumber: number | null;
  }[];
  batches: { id: string; batchNumber: number; sentAt: string; itemCount: number }[];
  history: { status: string; reason: string | null; occurredAt: string }[];
  /** Phase 21 (policies 8, 11-13): the allergies the warning checks, and each item's label. */
  allergy: OrderAllergyContext;
};

export type OrderAllergyContext = {
  /** PARTY: the visit's allergies (edited on the party). ORDER: this check's own. */
  source: "PARTY" | "ORDER";
  guestPartyId: string | null;
  partyVersion: number | null;
  /** Only with `guests.view`. */
  profile: { id: string; profileNumber: number; displayName: string; vip: boolean } | null;
  allergies: { allergenId: string; code: string; name: string; severity: "SEVERE" | "ALLERGY"; note: string | null }[];
  items: Record<
    string,
    {
      allergens: { id: string; code: string; name: string; kind: "CONTAINS" | "MAY_CONTAIN" }[];
      incomplete: boolean;
      conflict: { description: string; severity: "SEVERE" | "ALLERGY" } | null;
      acknowledged: { at: string; description: string } | null;
    }
  >;
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

  return readOrderDetail(executor, actor, orderId);
}

/** Unchecked read for a domain that authorized the caller itself; see `readOrderSummaries`. */
export async function readOrderDetail(
  executor: DatabaseExecutor,
  actor: Actor,
  orderId: string,
): Promise<OrderDetail> {
  const order = await findOrder(executor, actor, orderId);

  if (!order) {
    throw new NotFoundError("order");
  }

  const [summary] = await readOrderSummaries(executor, actor, { id: orderId });
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
  const shareRows = await executor
    .select({
      share: orderItemShares,
      itemName: orderItems.menuItemNameSnapshot,
      shareOrderNumber: orders.orderNumber,
    })
    .from(orderItemShares)
    .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItemShares.orderId))
    .where(
      itemIds.length === 0
        ? eq(orderItemShares.orderId, orderId)
        : or(eq(orderItemShares.orderId, orderId), inArray(orderItemShares.orderItemId, itemIds)),
    )
    .orderBy(asc(orderItemShares.orderItemId), asc(orderItemShares.shareNumber));

  const allergenView = await loadOrderAllergenView(
    executor,
    actor.organizationId,
    order,
    items.map(({ item }) => item),
  );
  const [party] = allergenView.allergies.guestPartyId
    ? await executor
        .select({ version: guestParties.version })
        .from(guestParties)
        .where(eq(guestParties.id, allergenView.allergies.guestPartyId))
    : [];
  const allergy: OrderAllergyContext = {
    source: allergenView.allergies.source,
    guestPartyId: allergenView.allergies.guestPartyId,
    partyVersion: party?.version ?? null,
    profile: actor.permissions.has("guests.view") ? allergenView.allergies.profile : null,
    allergies: allergenView.allergies.allergies,
    items: Object.fromEntries(
      [...allergenView.items].map(([itemId, view]) => [
        itemId,
        {
          allergens: view.label.allergens.map(({ id, code, name, kind }) => ({ id, code, name, kind })),
          incomplete: view.label.incomplete,
          conflict: view.conflict ? { description: view.conflict.description, severity: view.conflict.severity } : null,
          acknowledged: view.acknowledged,
        },
      ]),
    ),
  };

  return {
    ...summary!,
    allergy,
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
      courseNumber: item.courseNumber,
      taxRate: item.taxRateSnapshot,
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
    shares: shareRows.map(({ share, itemName, shareOrderNumber }) => ({
      id: share.id,
      orderItemId: share.orderItemId,
      itemName,
      shareNumber: share.shareNumber,
      shareCount: share.shareCount,
      amount: share.amount,
      status: share.status,
      version: share.version,
      elsewhereOrderNumber: share.orderId === orderId ? null : shareOrderNumber,
    })),
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
