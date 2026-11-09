import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { idempotencyRecords } from "./infrastructure";
import { orders } from "./orders";
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
    /** The Order's post-discount, pre-tax amount when the Settlement opened. */
    orderAmountSnapshot: money("order_amount_snapshot").notNull(),
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
    createdAt: createdAt(),
  },
  (table) => [
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
