import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { idempotencyRecords } from "./infrastructure";
import { cashDrawerSessions } from "./drawers";
import { orderItems, orders } from "./orders";
import { locations, organizations } from "./organization";

// Domain 12: Order Settlement (README section 19). Record only: nothing here authorizes,
// charges or refunds anything. A Settlement reconciles exactly to the Order's post-discount,
// pre-tax amount, captured as a snapshot when it opens. Tenders record how that amount was
// satisfied. No card number, CVV/CVC, track data, PIN or bank detail has a column.

/** 13 or more consecutive digits looks like a card number (PAN) and is never stored. */
const NO_PAN = (column: unknown) => sql`${column} IS NULL OR ${column} !~ '[0-9]{13,}'`;

export const settlements = pgTable(
  "order_settlements",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    orderId: uuid("order_id").notNull(),
    status: text("status").notNull().default("OPEN"),
    /**
     * The Order's amount due when the Settlement opened: Phase 17 `total_due` (subtotal
     * plus tax). Before Phase 17 it was the post-discount, pre-tax subtotal (tax was 0).
     */
    orderAmountSnapshot: money("order_amount_snapshot").notNull(),
    /** Phase 17: the tax part of the snapshot. Rows from before Phase 17 hold 0. */
    taxTotalSnapshot: money("tax_total_snapshot").notNull().default("0.00"),
    /** Phase 17: the pre-tax part of the snapshot, always computed. */
    subtotalSnapshot: money("subtotal_snapshot")
      .notNull()
      .generatedAlwaysAs(sql`order_amount_snapshot - tax_total_snapshot`),
    /** Projection: sum of RECORDED tender amounts applied to the Order. */
    tenderedAmount: money("tendered_amount").notNull().default("0.00"),
    /** Projection: sum of RECORDED tender tips. Separate from the Order obligation. */
    tipAmount: money("tip_amount").notNull().default("0.00"),
    /** Projection: sum of RECORDED cash change. */
    changeDue: money("change_due").notNull().default("0.00"),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openedAt: timestamptz("opened_at").notNull(),
    openedBusinessDate: businessDate("opened_business_date").notNull(),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    completedAt: timestamptz("completed_at"),
    completedBusinessDate: businessDate("completed_business_date"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelledAt: timestamptz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    version: versionColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "order_settlements_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_settlements_order_org_fk",
      columns: [table.orderId, table.organizationId],
      foreignColumns: [orders.id, orders.organizationId],
    }).onDelete("restrict"),
    check("order_settlements_status_valid", sql`${table.status} IN ('OPEN', 'COMPLETED', 'CANCELLED')`),
    check(
      "order_settlements_amounts_valid",
      sql`${table.orderAmountSnapshot} >= 0 AND ${table.tenderedAmount} >= 0
        AND ${table.tipAmount} >= 0 AND ${table.changeDue} >= 0
        AND ${table.tenderedAmount} <= ${table.orderAmountSnapshot}`,
    ),
    check(
      "order_settlements_tax_snapshot_valid",
      sql`${table.taxTotalSnapshot} >= 0 AND ${table.taxTotalSnapshot} <= ${table.orderAmountSnapshot}`,
    ),
    check(
      "order_settlements_completed_fields",
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)
        AND (${table.completedAt} IS NULL) = (${table.completedByUserId} IS NULL)
        AND (${table.completedAt} IS NULL) = (${table.completedBusinessDate} IS NULL)
        AND (${table.status} <> 'COMPLETED' OR ${table.tenderedAmount} = ${table.orderAmountSnapshot})`,
    ),
    check(
      "order_settlements_cancelled_fields",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)
        AND (${table.cancelledAt} IS NULL) = (${table.cancelledByUserId} IS NULL)
        AND (${table.cancelledAt} IS NULL) = (${table.cancelReason} IS NULL)
        AND (${table.cancelReason} IS NULL OR length(trim(${table.cancelReason})) > 0)`,
    ),
    uniqueIndex("order_settlements_one_open_per_order")
      .on(table.orderId)
      .where(sql`${table.status} = 'OPEN'`),
    uniqueIndex("order_settlements_one_completed_per_order")
      .on(table.orderId)
      .where(sql`${table.status} = 'COMPLETED'`),
    index("order_settlements_order_idx").on(table.orderId, table.openedAt),
    index("order_settlements_location_completed_date_idx").on(
      table.locationId,
      table.completedBusinessDate,
    ),
  ],
);

export const settlementTenders = pgTable(
  "settlement_tenders",
  {
    id: uuidPrimaryKey(),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "restrict" }),
    tenderType: text("tender_type").notNull(),
    status: text("status").notNull(),
    /** Amount applied to the Order obligation. Cash change and tip are not part of it. */
    amount: money("amount").notNull(),
    tipAmount: money("tip_amount").notNull().default("0.00"),
    /** Cash handed over by the guest. CASH only. */
    receivedAmount: money("received_amount"),
    changeAmount: money("change_amount").notNull().default("0.00"),
    externalReference: text("external_reference"),
    providerName: text("provider_name"),
    cardBrand: text("card_brand"),
    cardLastFour: text("card_last_four"),
    authorizationReference: text("authorization_reference"),
    otherDescription: text("other_description"),
    failureReason: text("failure_reason"),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamptz("recorded_at").notNull(),
    businessDate: businessDate().notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    /** Phase 17: the OPEN drawer session cash went into. CASH only. */
    cashDrawerSessionId: uuid("cash_drawer_session_id"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "settlement_tenders_drawer_session_fk",
      columns: [table.cashDrawerSessionId],
      foreignColumns: [cashDrawerSessions.id],
    }).onDelete("restrict"),
    check(
      "settlement_tenders_drawer_cash_only",
      sql`${table.cashDrawerSessionId} IS NULL OR ${table.tenderType} = 'CASH'`,
    ),
    index("settlement_tenders_drawer_session_idx").on(table.cashDrawerSessionId),
    foreignKey({
      name: "settlement_tenders_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    uniqueIndex("settlement_tenders_idempotency_unique").on(table.idempotencyRecordId),
    check(
      "settlement_tenders_type_valid",
      sql`${table.tenderType} IN ('CASH', 'EXTERNAL_CARD', 'GIFT_CARD', 'HOUSE_ACCOUNT', 'OTHER')`,
    ),
    check("settlement_tenders_status_valid", sql`${table.status} IN ('RECORDED', 'VOIDED', 'FAILED')`),
    check(
      "settlement_tenders_amounts_valid",
      sql`${table.amount} > 0 AND ${table.tipAmount} >= 0 AND ${table.changeAmount} >= 0`,
    ),
    check(
      "settlement_tenders_tip_types",
      sql`${table.tipAmount} = 0 OR ${table.tenderType} IN ('CASH', 'EXTERNAL_CARD')`,
    ),
    check(
      "settlement_tenders_cash_fields",
      sql`(${table.tenderType} = 'CASH') = (${table.receivedAmount} IS NOT NULL)
        AND (${table.tenderType} = 'CASH' OR ${table.changeAmount} = 0)
        AND (${table.receivedAmount} IS NULL
          OR ${table.changeAmount} = ${table.receivedAmount} - ${table.amount} - ${table.tipAmount})`,
    ),
    check(
      "settlement_tenders_failed_fields",
      sql`(${table.status} = 'FAILED') = (${table.failureReason} IS NOT NULL)
        AND (${table.status} <> 'FAILED' OR (${table.tenderType} = 'EXTERNAL_CARD' AND ${table.tipAmount} = 0))
        AND (${table.failureReason} IS NULL OR length(trim(${table.failureReason})) > 0)`,
    ),
    check(
      "settlement_tenders_other_description",
      sql`(${table.tenderType} <> 'OTHER' OR length(trim(coalesce(${table.otherDescription}, ''))) > 0)
        AND (${table.tenderType} = 'OTHER' OR ${table.otherDescription} IS NULL)`,
    ),
    check(
      "settlement_tenders_card_fields",
      sql`(${table.tenderType} = 'EXTERNAL_CARD'
          OR (${table.cardBrand} IS NULL AND ${table.cardLastFour} IS NULL))
        AND (${table.cardLastFour} IS NULL OR ${table.cardLastFour} ~ '^[0-9]{4}$')`,
    ),
    check(
      "settlement_tenders_no_pan",
      sql`(${NO_PAN(table.externalReference)}) AND (${NO_PAN(table.providerName)})
        AND (${NO_PAN(table.cardBrand)}) AND (${NO_PAN(table.authorizationReference)})
        AND (${NO_PAN(table.otherDescription)}) AND (${NO_PAN(table.failureReason)})
        AND (${NO_PAN(table.voidReason)})`,
    ),
    check(
      "settlement_tenders_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)
        AND (${table.voidReason} IS NULL OR length(trim(${table.voidReason})) > 0)`,
    ),
    index("settlement_tenders_settlement_idx").on(table.settlementId, table.recordedAt),
  ],
);

export const settlementStatusHistory = pgTable(
  "settlement_status_history",
  {
    id: uuidPrimaryKey(),
    settlementId: uuid("settlement_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "settlement_status_history_settlement_fk",
      columns: [table.settlementId],
      foreignColumns: [settlements.id],
    }).onDelete("restrict"),
    check(
      "settlement_status_history_status_valid",
      sql`${table.status} IN ('OPEN', 'COMPLETED', 'CANCELLED')`,
    ),
    index("settlement_status_history_settlement_idx").on(table.settlementId, table.occurredAt),
  ],
);

/**
 * Phase 17 refunds (approved policies B9-B13): money returned to a guest after the Order
 * CLOSED, recorded only. The Order, its Settlement and tenders never change; a refund is
 * its own append-only record, voided (never deleted) if it was a mistake.
 */
export const orderRefunds = pgTable(
  "order_refunds",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "restrict" }),
    refundNumber: integer("refund_number").notNull(),
    status: text("status").notNull().default("RECORDED"),
    tenderType: text("tender_type").notNull(),
    /** What went back to the guest, tax included. */
    amount: money("amount").notNull(),
    taxAmount: money("tax_amount").notNull().default("0.00"),
    /**
     * Phase 20 (policy 18, D17): tip handed back, apart from `amount`. CASH and EXTERNAL_CARD
     * only, never more than the order's recorded tender tips in total.
     */
    tipAmount: money("tip_amount").notNull().default("0.00"),
    reason: text("reason").notNull(),
    otherDescription: text("other_description"),
    externalReference: text("external_reference"),
    cashDrawerSessionId: uuid("cash_drawer_session_id"),
    businessDate: businessDate().notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamptz("recorded_at").notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    idempotencyRecordId: uuid("idempotency_record_id")
      .notNull()
      .references(() => idempotencyRecords.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "order_refunds_drawer_session_fk",
      columns: [table.cashDrawerSessionId],
      foreignColumns: [cashDrawerSessions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_refunds_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("order_refunds_order_number_unique").on(table.orderId, table.refundNumber),
    uniqueIndex("order_refunds_idempotency_unique").on(table.idempotencyRecordId),
    check(
      "order_refunds_type_valid",
      sql`${table.tenderType} IN ('CASH', 'EXTERNAL_CARD', 'GIFT_CARD', 'HOUSE_ACCOUNT', 'OTHER')`,
    ),
    check("order_refunds_status_valid", sql`${table.status} IN ('RECORDED', 'VOIDED')`),
    check(
      "order_refunds_amounts_valid",
      sql`${table.amount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.taxAmount} <= ${table.amount}
        AND ${table.tipAmount} >= 0 AND ${table.amount} + ${table.tipAmount} > 0
        AND (${table.tipAmount} = 0 OR ${table.tenderType} IN ('CASH', 'EXTERNAL_CARD'))`,
    ),
    check("order_refunds_reason", sql`length(trim(${table.reason})) > 0`),
    check(
      "order_refunds_other_description",
      sql`(${table.tenderType} <> 'OTHER' OR length(trim(coalesce(${table.otherDescription}, ''))) > 0)
        AND (${table.tenderType} = 'OTHER' OR ${table.otherDescription} IS NULL)`,
    ),
    check(
      "order_refunds_cash_fields",
      sql`(${table.tenderType} = 'CASH' OR ${table.cashDrawerSessionId} IS NULL)
        AND (${table.tenderType} <> 'CASH' OR ${table.externalReference} IS NULL)`,
    ),
    check(
      "order_refunds_no_pan",
      sql`(${NO_PAN(table.externalReference)}) AND (${NO_PAN(table.reason)})
        AND (${NO_PAN(table.otherDescription)}) AND (${NO_PAN(table.voidReason)})`,
    ),
    check(
      "order_refunds_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)
        AND (${table.voidReason} IS NULL OR length(trim(${table.voidReason})) > 0)`,
    ),
    index("order_refunds_location_date_idx").on(table.locationId, table.businessDate),
    index("order_refunds_order_idx").on(table.orderId),
  ],
);

/** Optional, informational links from a refund to the items it was about. */
export const orderRefundItems = pgTable(
  "order_refund_items",
  {
    refundId: uuid("refund_id")
      .notNull()
      .references(() => orderRefunds.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ name: "order_refund_items_pk", columns: [table.refundId, table.orderItemId] })],
);
