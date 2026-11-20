import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  guestLoyaltyBalances,
  guestLoyaltyEntries,
  guestLoyaltyPrograms,
  guestLoyaltyRedemptions,
  LOYALTY_ENTRY_KINDS,
  orderDiscounts,
  orderItemDiscounts,
  orders,
} from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { compareDecimals } from "@/shared/decimal/decimal";

// Phase 30 (policy 6): the one place loyalty entries are written. Every entry locks the
// profile's balance row first, so entries of one profile are serialized and each continues
// the running balance that migration 0071 checks.

export type LoyaltyEntryKind = (typeof LOYALTY_ENTRY_KINDS)[number];

export type LoyaltyEntryInput = {
  kind: LoyaltyEntryKind;
  points: number;
  guestPartyId?: string | null;
  orderId?: string | null;
  redemptionId?: string | null;
  relatedProfileId?: string | null;
  eligibleSubtotal?: string | null;
  pointsPerDollarSnapshot?: number | null;
  pointsPerVisitSnapshot?: number | null;
  reason?: string | null;
  /** Phase 33: REFUND_REVERSED / REFUND_RESTORED. */
  refundId?: string | null;
};

export type LoyaltyProgram = typeof guestLoyaltyPrograms.$inferSelect;

/** The organization's program, or the default (off) when none has been saved. */
export async function readLoyaltyProgram(executor: DatabaseExecutor, organizationId: string): Promise<LoyaltyProgram> {
  const [row] = await executor
    .select()
    .from(guestLoyaltyPrograms)
    .where(eq(guestLoyaltyPrograms.organizationId, organizationId));

  return (
    row ?? {
      organizationId,
      enabled: false,
      pointsPerDollar: 1,
      pointsPerVisit: 0,
      enabledAt: null,
      updatedByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      version: 0,
    }
  );
}

/** Locks (creating if needed) the profile's balance row and returns its balance. */
export async function lockLoyaltyBalance(
  transaction: DatabaseTransaction,
  organizationId: string,
  profileId: string,
): Promise<number> {
  const lock = () =>
    transaction
      .select({ balance: guestLoyaltyBalances.balance })
      .from(guestLoyaltyBalances)
      .where(eq(guestLoyaltyBalances.guestProfileId, profileId))
      .for("update");
  const [existing] = await lock();

  if (existing) {
    return existing.balance;
  }

  // First posting for this profile. The 0071 guard checks an inserted row against the
  // ledger before any conflict is seen, so a new row is only offered when none exists.
  await transaction
    .insert(guestLoyaltyBalances)
    .values({ guestProfileId: profileId, organizationId, balance: 0 })
    .onConflictDoNothing({ target: guestLoyaltyBalances.guestProfileId });

  const [row] = await lock();

  return row!.balance;
}

/**
 * Writes one entry and moves the balance with it, in the caller's transaction. The caller
 * has checked the business rule; PostgreSQL refuses a negative balance or a broken chain.
 */
export async function postLoyaltyEntry(
  transaction: DatabaseTransaction,
  actor: Actor,
  profileId: string,
  entry: LoyaltyEntryInput,
  at: Date = new Date(),
): Promise<{ entryId: string; balanceAfter: number }> {
  const balance = await lockLoyaltyBalance(transaction, actor.organizationId, profileId);
  const balanceAfter = balance + entry.points;
  const clock = await readLocationClock(transaction, actor.locationId, at);
  const [row] = await transaction
    .insert(guestLoyaltyEntries)
    .values({
      organizationId: actor.organizationId,
      guestProfileId: profileId,
      kind: entry.kind,
      points: entry.points,
      balanceAfter,
      locationId: actor.locationId,
      businessDate: clock.businessDate,
      guestPartyId: entry.guestPartyId ?? null,
      orderId: entry.orderId ?? null,
      redemptionId: entry.redemptionId ?? null,
      relatedProfileId: entry.relatedProfileId ?? null,
      eligibleSubtotal: entry.eligibleSubtotal ?? null,
      pointsPerDollarSnapshot: entry.pointsPerDollarSnapshot ?? null,
      pointsPerVisitSnapshot: entry.pointsPerVisitSnapshot ?? null,
      reason: entry.reason ?? null,
      refundId: entry.refundId ?? null,
      createdByUserId: actor.userId,
      occurredAt: at,
    })
    .returning({ id: guestLoyaltyEntries.id });

  await transaction
    .update(guestLoyaltyBalances)
    .set({ balance: balanceAfter, updatedAt: at })
    .where(eq(guestLoyaltyBalances.guestProfileId, profileId));

  return { entryId: row!.id, balanceAfter };
}

/**
 * Policy 9: the points of rewards on checks not yet closed. A redemption is pending while its
 * order is OPEN and its discount still APPLIED.
 */
export async function pendingRedemptions(executor: DatabaseExecutor, profileId: string) {
  const rows = await executor
    .select({
      id: guestLoyaltyRedemptions.id,
      orderId: guestLoyaltyRedemptions.orderId,
      guestPartyId: guestLoyaltyRedemptions.guestPartyId,
      pointsCost: guestLoyaltyRedemptions.pointsCostSnapshot,
      rewardName: guestLoyaltyRedemptions.rewardNameSnapshot,
      orderDiscountStatus: orderDiscounts.status,
      itemDiscountStatus: orderItemDiscounts.status,
    })
    .from(guestLoyaltyRedemptions)
    .innerJoin(orders, eq(orders.id, guestLoyaltyRedemptions.orderId))
    .leftJoin(orderDiscounts, eq(orderDiscounts.id, guestLoyaltyRedemptions.orderDiscountId))
    .leftJoin(orderItemDiscounts, eq(orderItemDiscounts.id, guestLoyaltyRedemptions.orderItemDiscountId))
    .where(and(eq(guestLoyaltyRedemptions.guestProfileId, profileId), eq(orders.status, "OPEN")));

  return rows.filter((row) => (row.orderDiscountStatus ?? row.itemDiscountStatus) === "APPLIED");
}

/** Whether a party has any reward applied, pending or posted (policy 10's unlink rule). */
export async function partyHasRedemption(executor: DatabaseExecutor, partyId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: guestLoyaltyRedemptions.id })
    .from(guestLoyaltyRedemptions)
    .where(eq(guestLoyaltyRedemptions.guestPartyId, partyId))
    .limit(1);

  return Boolean(row);
}

/** Policy 9 and amendment 6: the redemptions on a closing check whose points now leave. */
export async function redemptionsToPost(executor: DatabaseExecutor, orderId: string) {
  const rows = await executor
    .select({
      id: guestLoyaltyRedemptions.id,
      guestProfileId: guestLoyaltyRedemptions.guestProfileId,
      guestPartyId: guestLoyaltyRedemptions.guestPartyId,
      pointsCost: guestLoyaltyRedemptions.pointsCostSnapshot,
      orderStatus: orderDiscounts.status,
      orderAmount: orderDiscounts.appliedAmount,
      itemStatus: orderItemDiscounts.status,
      itemAmount: orderItemDiscounts.appliedAmount,
    })
    .from(guestLoyaltyRedemptions)
    .leftJoin(orderDiscounts, eq(orderDiscounts.id, guestLoyaltyRedemptions.orderDiscountId))
    .leftJoin(orderItemDiscounts, eq(orderItemDiscounts.id, guestLoyaltyRedemptions.orderItemDiscountId))
    .leftJoin(
      guestLoyaltyEntries,
      and(eq(guestLoyaltyEntries.redemptionId, guestLoyaltyRedemptions.id), eq(guestLoyaltyEntries.kind, "REDEEMED")),
    )
    .where(and(eq(guestLoyaltyRedemptions.orderId, orderId), isNull(guestLoyaltyEntries.id)))
    .orderBy(guestLoyaltyRedemptions.redeemedAt, guestLoyaltyRedemptions.id);

  return rows.filter((row) => {
    const status = row.orderStatus ?? row.itemStatus;
    const amount = row.orderAmount ?? row.itemAmount ?? "0.00";

    return status === "APPLIED" && compareDecimals(amount, "0") > 0;
  });
}

/** The profiles' balances (0 when none was ever written). */
export async function readBalances(executor: DatabaseExecutor, profileIds: readonly string[]) {
  if (profileIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await executor
    .select({ id: guestLoyaltyBalances.guestProfileId, balance: guestLoyaltyBalances.balance })
    .from(guestLoyaltyBalances)
    .where(inArray(guestLoyaltyBalances.guestProfileId, [...profileIds]));

  return new Map(rows.map((row) => [row.id, row.balance]));
}
