import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
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
import { cashDrawerSessions } from "./drawers";
import { idempotencyRecords } from "./infrastructure";
import { locations, organizations } from "./organization";

// Phase 31 gift cards, owned by Settlements (policy 3). The restaurant's own stored-value
// cards, record only: nothing here charges a card or contacts a provider. A card's code is a
// bearer secret, so only its SHA-256 hash and last four characters are kept (policy 5). The
// ledger (`gift_card_entries`, guarded by migration 0073) lives in gift-card-entries.ts so
// that settlements.ts can reference cards without an import cycle.

/** 13 or more consecutive digits looks like a card number (PAN) and is never stored. */
const NO_PAN = (column: unknown) => sql`${column} IS NULL OR ${column} !~ '[0-9]{13,}'`;

export const GIFT_CARD_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const GIFT_CARD_SALE_KINDS = ["ISSUED", "RELOADED"] as const;
export const GIFT_CARD_SALE_TENDER_TYPES = ["CASH", "EXTERNAL_CARD", "OTHER"] as const;

/** Policy 8: one row per organization, off until a manager turns gift cards on. */
export const giftCardPrograms = pgTable(
  "gift_card_programs",
  {
    organizationId: uuid("organization_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    maxBalance: money("max_balance").notNull().default("500.00"),
    /** When gift cards were first turned on. */
    enabledAt: timestamptz("enabled_at"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "gift_card_programs_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("gift_card_programs_max_valid", sql`${table.maxBalance} >= 1.00 AND ${table.maxBalance} <= 10000.00`),
    check("gift_card_programs_enabled_at", sql`NOT ${table.enabled} OR ${table.enabledAt} IS NOT NULL`),
  ],
);

/** One counter per organization for the non-secret card numbers (`GC-000123`). */
export const giftCardNumberCounters = pgTable(
  "gift_card_number_counters",
  {
    organizationId: uuid("organization_id").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "gift_card_number_counters_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("gift_card_number_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

/**
 * Policies 5–7, 12: one card. Its balance moves only with a ledger entry (migration 0073
 * keeps it equal to the latest `balance_after`). Deactivated, never deleted.
 */
export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    cardNumber: integer("card_number").notNull(),
    /** SHA-256 (hex) of the normalized code. The code itself is never stored. */
    codeHash: text("code_hash").notNull(),
    /** The code's last four characters, for staff to tell cards apart. Never audited. */
    codeLastFour: text("code_last_four").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    balance: money("balance").notNull().default("0.00"),
    issuedLocationId: uuid("issued_location_id").notNull(),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedAt: timestamptz("issued_at").notNull(),
    statusReason: text("status_reason"),
    codeReplacedAt: timestamptz("code_replaced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "gift_cards_location_org_fk",
      columns: [table.issuedLocationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("gift_cards_id_org_unique").on(table.id, table.organizationId),
    unique("gift_cards_org_number_unique").on(table.organizationId, table.cardNumber),
    uniqueIndex("gift_cards_code_hash_unique").on(table.codeHash),
    check("gift_cards_number_positive", sql`${table.cardNumber} > 0`),
    check("gift_cards_code_hash_valid", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check("gift_cards_code_last_four_valid", sql`${table.codeLastFour} ~ '^[0-9A-Z]{4}$'`),
    check("gift_cards_status_valid", sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check("gift_cards_balance_non_negative", sql`${table.balance} >= 0`),
    check(
      "gift_cards_status_reason",
      sql`(${table.statusReason} IS NULL OR length(trim(${table.statusReason})) > 0) AND (${NO_PAN(table.statusReason)})`,
    ),
  ],
);

/**
 * Policy 4: a card sold or reloaded, and how the guest paid for it. Not an order and not
 * revenue: no tax, no tip, no sales report. Voided (policy 11), never deleted.
 */
export const giftCardSales = pgTable(
  "gift_card_sales",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    locationId: uuid("location_id").notNull(),
    giftCardId: uuid("gift_card_id").notNull(),
    kind: text("kind").notNull(),
    amount: money("amount").notNull(),
    tenderType: text("tender_type").notNull(),
    /** Cash handed over. CASH only; change = received - amount. */
    receivedAmount: money("received_amount"),
    changeAmount: money("change_amount").notNull().default("0.00"),
    externalReference: text("external_reference"),
    providerName: text("provider_name"),
    cardBrand: text("card_brand"),
    cardLastFour: text("card_last_four"),
    authorizationReference: text("authorization_reference"),
    otherDescription: text("other_description"),
    cashDrawerSessionId: uuid("cash_drawer_session_id"),
    businessDate: businessDate().notNull(),
    status: text("status").notNull().default("RECORDED"),
    soldByUserId: uuid("sold_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    soldAt: timestamptz("sold_at").notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    voidedBusinessDate: businessDate("voided_business_date"),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "gift_card_sales_card_org_fk",
      columns: [table.giftCardId, table.organizationId],
      foreignColumns: [giftCards.id, giftCards.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_sales_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_sales_drawer_session_fk",
      columns: [table.cashDrawerSessionId],
      foreignColumns: [cashDrawerSessions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "gift_card_sales_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    uniqueIndex("gift_card_sales_idempotency_unique").on(table.idempotencyRecordId),
    check("gift_card_sales_kind_valid", sql`${table.kind} IN ('ISSUED', 'RELOADED')`),
    check("gift_card_sales_type_valid", sql`${table.tenderType} IN ('CASH', 'EXTERNAL_CARD', 'OTHER')`),
    check("gift_card_sales_status_valid", sql`${table.status} IN ('RECORDED', 'VOIDED')`),
    check("gift_card_sales_amount_positive", sql`${table.amount} > 0 AND ${table.changeAmount} >= 0`),
    check(
      "gift_card_sales_cash_fields",
      sql`(${table.tenderType} = 'CASH') = (${table.receivedAmount} IS NOT NULL)
        AND (${table.tenderType} = 'CASH' OR ${table.changeAmount} = 0)
        AND (${table.receivedAmount} IS NULL OR ${table.changeAmount} = ${table.receivedAmount} - ${table.amount})
        AND (${table.tenderType} = 'CASH' OR ${table.cashDrawerSessionId} IS NULL)
        AND (${table.tenderType} <> 'CASH' OR ${table.externalReference} IS NULL)`,
    ),
    check(
      "gift_card_sales_card_fields",
      sql`(${table.tenderType} = 'EXTERNAL_CARD'
          OR (${table.cardBrand} IS NULL AND ${table.cardLastFour} IS NULL
            AND ${table.providerName} IS NULL AND ${table.authorizationReference} IS NULL))
        AND (${table.cardLastFour} IS NULL OR ${table.cardLastFour} ~ '^[0-9]{4}$')`,
    ),
    check(
      "gift_card_sales_other_description",
      sql`(${table.tenderType} <> 'OTHER' OR length(trim(coalesce(${table.otherDescription}, ''))) > 0)
        AND (${table.tenderType} = 'OTHER' OR ${table.otherDescription} IS NULL)`,
    ),
    check(
      "gift_card_sales_no_pan",
      sql`(${NO_PAN(table.externalReference)}) AND (${NO_PAN(table.providerName)})
        AND (${NO_PAN(table.cardBrand)}) AND (${NO_PAN(table.authorizationReference)})
        AND (${NO_PAN(table.otherDescription)}) AND (${NO_PAN(table.voidReason)})`,
    ),
    check(
      "gift_card_sales_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedBusinessDate} IS NULL)
        AND (${table.voidReason} IS NULL OR length(trim(${table.voidReason})) > 0)`,
    ),
    index("gift_card_sales_card_idx").on(table.giftCardId, table.soldAt),
    index("gift_card_sales_location_date_idx").on(table.locationId, table.businessDate),
    index("gift_card_sales_drawer_session_idx").on(table.cashDrawerSessionId),
  ],
);
