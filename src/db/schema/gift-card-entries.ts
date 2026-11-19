import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz } from "../helpers/timestamps";
import { users } from "./auth";
import { cashDrawerSessions } from "./drawers";
import { giftCardSales, giftCards } from "./gift-cards";
import { locations } from "./organization";
import { orderRefunds, settlementTenders } from "./settlements";

// Phase 31 (policy 7): the authoritative gift card ledger. Signed money (positive adds value);
// each row carries the card's balance after it. Migration 0073 refuses UPDATE and DELETE and
// checks that `balance_after` continues the card's previous entry.

export const GIFT_CARD_ENTRY_KINDS = [
  "ISSUED",
  "RELOADED",
  "SALE_VOIDED",
  "REDEEMED",
  "REDEMPTION_VOIDED",
  "REFUNDED",
  "REFUND_VOIDED",
  "ADJUSTED",
  "CASHED_OUT",
] as const;

export const giftCardEntries = pgTable(
  "gift_card_entries",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    giftCardId: uuid("gift_card_id").notNull(),
    /** Posting order per card, for the running balance. */
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    kind: text("kind").notNull(),
    amount: money("amount").notNull(),
    balanceAfter: money("balance_after").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    businessDate: businessDate().notNull(),
    saleId: uuid("sale_id"),
    tenderId: uuid("tender_id"),
    refundId: uuid("refund_id"),
    /** CASHED_OUT: the drawer session the cash left. */
    cashDrawerSessionId: uuid("cash_drawer_session_id"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "gift_card_entries_card_org_fk",
      columns: [table.giftCardId, table.organizationId],
      foreignColumns: [giftCards.id, giftCards.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_entries_sale_fk",
      columns: [table.saleId],
      foreignColumns: [giftCardSales.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_entries_tender_fk",
      columns: [table.tenderId],
      foreignColumns: [settlementTenders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_entries_refund_fk",
      columns: [table.refundId],
      foreignColumns: [orderRefunds.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_entries_drawer_session_fk",
      columns: [table.cashDrawerSessionId],
      foreignColumns: [cashDrawerSessions.id],
    }).onDelete("restrict"),
    unique("gift_card_entries_kind_sale_unique").on(table.kind, table.saleId),
    unique("gift_card_entries_kind_tender_unique").on(table.kind, table.tenderId),
    unique("gift_card_entries_kind_refund_unique").on(table.kind, table.refundId),
    check(
      "gift_card_entries_kind_valid",
      sql`${table.kind} IN ('ISSUED', 'RELOADED', 'SALE_VOIDED', 'REDEEMED', 'REDEMPTION_VOIDED',
        'REFUNDED', 'REFUND_VOIDED', 'ADJUSTED', 'CASHED_OUT')`,
    ),
    check("gift_card_entries_amount_nonzero", sql`${table.amount} <> 0`),
    check("gift_card_entries_balance_non_negative", sql`${table.balanceAfter} >= 0`),
    check(
      "gift_card_entries_sign_valid",
      sql`(${table.kind} IN ('ISSUED', 'RELOADED', 'REDEMPTION_VOIDED', 'REFUNDED') AND ${table.amount} > 0)
        OR (${table.kind} IN ('SALE_VOIDED', 'REDEEMED', 'REFUND_VOIDED', 'CASHED_OUT') AND ${table.amount} < 0)
        OR ${table.kind} = 'ADJUSTED'`,
    ),
    check(
      "gift_card_entries_references",
      sql`((${table.kind} IN ('ISSUED', 'RELOADED', 'SALE_VOIDED')) = (${table.saleId} IS NOT NULL))
        AND ((${table.kind} IN ('REDEEMED', 'REDEMPTION_VOIDED')) = (${table.tenderId} IS NOT NULL))
        AND ((${table.kind} IN ('REFUNDED', 'REFUND_VOIDED')) = (${table.refundId} IS NOT NULL))
        AND (${table.kind} = 'CASHED_OUT' OR ${table.cashDrawerSessionId} IS NULL)`,
    ),
    check(
      "gift_card_entries_reason",
      sql`(${table.kind} NOT IN ('SALE_VOIDED', 'ADJUSTED', 'CASHED_OUT')
          OR length(trim(coalesce(${table.reason}, ''))) > 0)
        AND (${table.reason} IS NULL OR ${table.reason} !~ '[0-9]{13,}')`,
    ),
    index("gift_card_entries_card_idx").on(table.giftCardId, table.sequence),
    index("gift_card_entries_location_date_idx").on(table.locationId, table.businessDate),
    index("gift_card_entries_drawer_session_idx").on(table.cashDrawerSessionId),
  ],
);
