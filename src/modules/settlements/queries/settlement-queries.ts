import { asc, eq, inArray } from "drizzle-orm";

import { settlements, settlementTenders } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { readOrderDetail } from "@/modules/orders/queries/order-queries";
import { compareDecimals } from "@/shared/decimal/decimal";

import { reconcile } from "../rules/settlement-math";
import type { SettlementStatus, TenderStatus, TenderType } from "../types";
import { actorHolds, assertPermission } from "../services/access";

// Purpose-built settlement read models. No recipe, inventory or cost data, and safe
// external references and card metadata only for `settlements.view-card-metadata`.
// No card number, CVV or similar is ever stored, so none can be returned.

export type TenderDetail = {
  id: string;
  tenderType: TenderType;
  status: TenderStatus;
  amount: string;
  tipAmount: string;
  receivedAmount: string | null;
  changeAmount: string;
  otherDescription: string | null;
  failureReason: string | null;
  recordedAt: string;
  businessDate: string;
  voidedAt: string | null;
  voidReason: string | null;
  /** Null when the viewer may not see it, or nothing was recorded. */
  reference: {
    externalReference: string | null;
    providerName: string | null;
    cardBrand: string | null;
    cardLastFour: string | null;
    authorizationReference: string | null;
  } | null;
};

export type SettlementDetail = {
  id: string;
  status: SettlementStatus;
  orderAmountSnapshot: string;
  tenderedAmount: string;
  tipAmount: string;
  changeDue: string;
  remainingAmount: string;
  openedAt: string;
  openedBusinessDate: string;
  completedAt: string | null;
  completedBusinessDate: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
  tenders: TenderDetail[];
};

export type OrderSettlementView = {
  order: {
    id: string;
    orderNumber: number;
    businessDate: string;
    orderType: string;
    status: string;
    tableNumbers: string[];
    customerName: string | null;
    serverName: string | null;
    itemSubtotal: string;
    discountTotal: string;
    /** Post-discount, pre-tax: the amount settled. Tax isn't calculated. */
    subtotal: string;
    draftCount: number;
    fullyComped: boolean;
    items: {
      id: string;
      name: string;
      quantity: number;
      status: string;
      lineTotal: string;
      discounts: { name: string; appliedAmount: string; isComp: boolean; status: string }[];
    }[];
    discounts: { name: string; appliedAmount: string; isComp: boolean; status: string }[];
  };
  /** The OPEN settlement, else the COMPLETED one, else null. */
  current: SettlementDetail | null;
  /** Every settlement for the order, oldest first, including cancelled ones. */
  history: SettlementDetail[];
  eligibility: {
    canOpen: boolean;
    canComplete: boolean;
    reasons: string[];
  };
  referencesVisible: boolean;
};

function toTender(row: typeof settlementTenders.$inferSelect, showReferences: boolean): TenderDetail {
  const reference = {
    externalReference: row.externalReference,
    providerName: row.providerName,
    cardBrand: row.cardBrand,
    cardLastFour: row.cardLastFour,
    authorizationReference: row.authorizationReference,
  };

  return {
    id: row.id,
    tenderType: row.tenderType as TenderType,
    status: row.status as TenderStatus,
    amount: row.amount,
    tipAmount: row.tipAmount,
    receivedAmount: row.receivedAmount,
    changeAmount: row.changeAmount,
    otherDescription: row.otherDescription,
    failureReason: row.failureReason,
    recordedAt: row.recordedAt.toISOString(),
    businessDate: row.businessDate,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    reference: showReferences && Object.values(reference).some(Boolean) ? reference : null,
  };
}

const discountSummary = (entry: { name: string; appliedAmount: string; isComp: boolean; status: string }) => ({
  name: entry.name,
  appliedAmount: entry.appliedAmount,
  isComp: entry.isComp,
  status: entry.status,
});

export async function getOrderSettlementView(
  executor: DatabaseExecutor,
  actor: Actor,
  orderId: string,
): Promise<OrderSettlementView> {
  assertPermission(actor, "settlements.view");

  // Location-scoped: another location's order looks absent.
  const order = await readOrderDetail(executor, actor, orderId);
  const showReferences = actorHolds(actor, "settlements.view-card-metadata");
  const rows = await executor
    .select()
    .from(settlements)
    .where(eq(settlements.orderId, order.id))
    .orderBy(asc(settlements.openedAt), asc(settlements.id));
  const tenders =
    rows.length === 0
      ? []
      : await executor
          .select()
          .from(settlementTenders)
          .where(inArray(settlementTenders.settlementId, rows.map((row) => row.id)))
          .orderBy(asc(settlementTenders.recordedAt), asc(settlementTenders.id));
  const history: SettlementDetail[] = rows.map((row) => {
    const own = tenders.filter((tender) => tender.settlementId === row.id);

    return {
      id: row.id,
      status: row.status as SettlementStatus,
      orderAmountSnapshot: row.orderAmountSnapshot,
      tenderedAmount: row.tenderedAmount,
      tipAmount: row.tipAmount,
      changeDue: row.changeDue,
      remainingAmount: reconcile(row.orderAmountSnapshot, own).remainingAmount,
      openedAt: row.openedAt.toISOString(),
      openedBusinessDate: row.openedBusinessDate,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedBusinessDate: row.completedBusinessDate,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      version: row.version,
      tenders: own.map((tender) => toTender(tender, showReferences)),
    };
  });
  const current =
    history.find((entry) => entry.status === "OPEN") ??
    history.find((entry) => entry.status === "COMPLETED") ??
    null;
  const reasons: string[] = [];

  if (order.status !== "OPEN") {
    reasons.push(order.status === "VOIDED" ? "The order was voided." : "The order is closed.");
  }

  if (order.draftCount > 0) {
    reasons.push("Send or remove the unsent items before completing.");
  }

  const open = current?.status === "OPEN" ? current : null;

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      businessDate: order.businessDate,
      orderType: order.orderType,
      status: order.status,
      tableNumbers: order.tableNumbers,
      customerName: order.customerName,
      serverName: order.serverName,
      itemSubtotal: order.itemSubtotal,
      discountTotal: order.discountTotal,
      subtotal: order.subtotal,
      draftCount: order.draftCount,
      fullyComped:
        compareDecimals(order.itemSubtotal, "0") > 0 && compareDecimals(order.subtotal, "0") === 0,
      items: order.items
        .filter((item) => item.status !== "DRAFT")
        .map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          status: item.status,
          lineTotal: item.lineTotal,
          discounts: item.discounts.map(discountSummary),
        })),
      discounts: order.discounts.map(discountSummary),
    },
    current,
    history,
    eligibility: {
      canOpen: order.status === "OPEN" && !open,
      canComplete:
        order.status === "OPEN" &&
        order.draftCount === 0 &&
        open !== null &&
        compareDecimals(open.remainingAmount, "0") === 0,
      reasons,
    },
    referencesVisible: showReferences,
  };
}
