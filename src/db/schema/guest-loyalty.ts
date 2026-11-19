import { sql } from "drizzle-orm";
import {
  bigint,
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

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { guestParties, guestProfiles } from "./guest-parties";
import { discountDefinitions, orderDiscounts, orderItemDiscounts, orders } from "./orders";
import { locations, organizations } from "./organization";

// Phase 30 guest loyalty, owned by Reservations. One program per organization; an append-only
// points ledger per guest profile (`guest_loyalty_entries`, guarded by migration 0071) with a
// balance row that changes with it; rewards that are reward-only discount definitions; and a
// record of each reward applied to a check, whose points leave the balance when it closes.

export const LOYALTY_ENTRY_KINDS = ["EARNED", "REDEEMED", "ADJUSTED", "MERGED_OUT", "MERGED_IN", "ERASED"] as const;

/** Policy 5: one program row per organization, off until a manager enables it. */
export const guestLoyaltyPrograms = pgTable(
  "guest_loyalty_programs",
  {
    organizationId: uuid("organization_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    pointsPerDollar: integer("points_per_dollar").notNull().default(1),
    pointsPerVisit: integer("points_per_visit").notNull().default(0),
    /** When the program was first enabled. Visits finished before it never earn. */
    enabledAt: timestamptz("enabled_at"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "guest_loyalty_programs_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check(
      "guest_loyalty_programs_rates_valid",
      sql`${table.pointsPerDollar} BETWEEN 0 AND 100 AND ${table.pointsPerVisit} BETWEEN 0 AND 100`,
    ),
    check("guest_loyalty_programs_enabled_at", sql`NOT ${table.enabled} OR ${table.enabledAt} IS NOT NULL`),
  ],
);

/** One counter per organization for human-readable reward numbers. */
export const guestLoyaltyRewardNumberCounters = pgTable(
  "guest_loyalty_reward_number_counters",
  {
    organizationId: uuid("organization_id").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "guest_loyalty_reward_counters_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    check("guest_loyalty_reward_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

/** Policy 7: a reward costs whole points and applies its own reward-only discount definition. */
export const guestLoyaltyRewards = pgTable(
  "guest_loyalty_rewards",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rewardNumber: integer("reward_number").notNull(),
    name: text("name").notNull(),
    pointsCost: integer("points_cost").notNull(),
    discountDefinitionId: uuid("discount_definition_id").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    // Named explicitly: the generated names exceed PostgreSQL's 63-character limit.
    foreignKey({
      name: "guest_loyalty_rewards_definition_fk",
      columns: [table.discountDefinitionId],
      foreignColumns: [discountDefinitions.id],
    }).onDelete("restrict"),
    unique("guest_loyalty_rewards_org_number_unique").on(table.organizationId, table.rewardNumber),
    unique("guest_loyalty_rewards_definition_unique").on(table.discountDefinitionId),
    check("guest_loyalty_rewards_number_positive", sql`${table.rewardNumber} > 0`),
    check("guest_loyalty_rewards_cost_positive", sql`${table.pointsCost} > 0 AND ${table.pointsCost} <= 1000000`),
    check("guest_loyalty_rewards_name_valid", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
  ],
);

/**
 * Policy 8: a reward applied to a check. Append-only. It is pending while its order is OPEN
 * and its discount APPLIED; `close-order` then posts its `REDEEMED` entry (policy 9).
 */
export const guestLoyaltyRedemptions = pgTable(
  "guest_loyalty_redemptions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    rewardId: uuid("reward_id").notNull(),
    guestProfileId: uuid("guest_profile_id").notNull(),
    guestPartyId: uuid("guest_party_id")
      .notNull()
      .references(() => guestParties.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    orderDiscountId: uuid("order_discount_id"),
    orderItemDiscountId: uuid("order_item_discount_id"),
    rewardNameSnapshot: text("reward_name_snapshot").notNull(),
    pointsCostSnapshot: integer("points_cost_snapshot").notNull(),
    redeemedByUserId: uuid("redeemed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    redeemedAt: timestamptz("redeemed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_loyalty_redemptions_profile_fk",
      columns: [table.guestProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_loyalty_redemptions_reward_fk",
      columns: [table.rewardId],
      foreignColumns: [guestLoyaltyRewards.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_loyalty_redemptions_order_discount_fk",
      columns: [table.orderDiscountId],
      foreignColumns: [orderDiscounts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_loyalty_redemptions_item_discount_fk",
      columns: [table.orderItemDiscountId],
      foreignColumns: [orderItemDiscounts.id],
    }).onDelete("restrict"),
    unique("guest_loyalty_redemptions_order_discount_unique").on(table.orderDiscountId),
    unique("guest_loyalty_redemptions_item_discount_unique").on(table.orderItemDiscountId),
    check(
      "guest_loyalty_redemptions_one_discount",
      sql`(${table.orderDiscountId} IS NULL) <> (${table.orderItemDiscountId} IS NULL)`,
    ),
    check("guest_loyalty_redemptions_cost_positive", sql`${table.pointsCostSnapshot} > 0`),
    index("guest_loyalty_redemptions_profile_idx").on(table.guestProfileId),
    index("guest_loyalty_redemptions_order_idx").on(table.orderId),
    index("guest_loyalty_redemptions_party_idx").on(table.guestPartyId),
  ],
);

/**
 * Policy 6: the authoritative points ledger. Signed whole points (positive adds); each row
 * carries the profile's balance after it. Migration 0071 refuses UPDATE and DELETE and checks
 * that `balance_after` continues the profile's previous entry.
 */
export const guestLoyaltyEntries = pgTable(
  "guest_loyalty_entries",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    guestProfileId: uuid("guest_profile_id").notNull(),
    /** Posting order per profile, for the running balance. */
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    kind: text("kind").notNull(),
    points: integer("points").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    businessDate: businessDate(),
    guestPartyId: uuid("guest_party_id").references(() => guestParties.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    redemptionId: uuid("redemption_id"),
    /** MERGED_OUT / MERGED_IN: the other profile of the merge. */
    relatedProfileId: uuid("related_profile_id").references(() => guestProfiles.id, { onDelete: "restrict" }),
    /** EARNED: the CLOSED check subtotals and the rates in effect, as they were. */
    eligibleSubtotal: money("eligible_subtotal"),
    pointsPerDollarSnapshot: integer("points_per_dollar_snapshot"),
    pointsPerVisitSnapshot: integer("points_per_visit_snapshot"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_loyalty_entries_profile_fk",
      columns: [table.guestProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "guest_loyalty_entries_redemption_fk",
      columns: [table.redemptionId],
      foreignColumns: [guestLoyaltyRedemptions.id],
    }).onDelete("restrict"),
    check(
      "guest_loyalty_entries_kind_valid",
      sql`${table.kind} IN ('EARNED', 'REDEEMED', 'ADJUSTED', 'MERGED_OUT', 'MERGED_IN', 'ERASED')`,
    ),
    check("guest_loyalty_entries_points_nonzero", sql`${table.points} <> 0`),
    check("guest_loyalty_entries_balance_non_negative", sql`${table.balanceAfter} >= 0`),
    check(
      "guest_loyalty_entries_sign_valid",
      sql`(${table.kind} IN ('EARNED', 'MERGED_IN') AND ${table.points} > 0)
        OR (${table.kind} IN ('REDEEMED', 'MERGED_OUT', 'ERASED') AND ${table.points} < 0)
        OR ${table.kind} = 'ADJUSTED'`,
    ),
    check(
      "guest_loyalty_entries_earned_fields",
      sql`${table.kind} <> 'EARNED' OR (${table.guestPartyId} IS NOT NULL AND ${table.eligibleSubtotal} IS NOT NULL
        AND ${table.pointsPerDollarSnapshot} IS NOT NULL AND ${table.pointsPerVisitSnapshot} IS NOT NULL)`,
    ),
    check(
      "guest_loyalty_entries_redeemed_fields",
      sql`${table.kind} <> 'REDEEMED' OR (${table.orderId} IS NOT NULL AND ${table.redemptionId} IS NOT NULL)`,
    ),
    check(
      "guest_loyalty_entries_merge_fields",
      sql`${table.kind} NOT IN ('MERGED_OUT', 'MERGED_IN') OR ${table.relatedProfileId} IS NOT NULL`,
    ),
    check(
      "guest_loyalty_entries_reason_valid",
      sql`(${table.kind} <> 'ADJUSTED' OR ${table.reason} IS NOT NULL)
        AND (${table.reason} IS NULL OR length(trim(${table.reason})) BETWEEN 1 AND 200)`,
    ),
    check("guest_loyalty_entries_reason_no_card_digits", sql`(${table.reason} IS NULL OR ${table.reason} !~ '[0-9]{13,}')`),
    unique("guest_loyalty_entries_sequence_unique").on(table.sequence),
    uniqueIndex("guest_loyalty_entries_earned_party_unique")
      .on(table.guestPartyId)
      .where(sql`${table.kind} = 'EARNED'`),
    uniqueIndex("guest_loyalty_entries_redeemed_unique")
      .on(table.redemptionId)
      .where(sql`${table.kind} = 'REDEEMED'`),
    index("guest_loyalty_entries_profile_sequence_idx").on(table.guestProfileId, table.sequence),
    index("guest_loyalty_entries_org_date_idx").on(table.organizationId, table.businessDate),
  ],
);

/** Policy 6: the profile's current points, changed only with a ledger entry (guarded by 0071). */
export const guestLoyaltyBalances = pgTable(
  "guest_loyalty_balances",
  {
    guestProfileId: uuid("guest_profile_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    balance: integer("balance").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "guest_loyalty_balances_profile_fk",
      columns: [table.guestProfileId, table.organizationId],
      foreignColumns: [guestProfiles.id, guestProfiles.organizationId],
    }).onDelete("restrict"),
    check("guest_loyalty_balances_non_negative", sql`${table.balance} >= 0`),
  ],
);
