import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  guestLoyaltyEntries,
  guestLoyaltyPrograms,
  guestLoyaltyRewardNumberCounters,
  guestLoyaltyRewards,
  discountDefinitions,
  guestParties,
  guestProfiles,
  orderRefunds,
  orders,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  createRewardDiscountDefinition,
  updateRewardDiscountDefinition,
} from "@/modules/orders/services/discount-service";
import type { DiscountScope, DiscountType } from "@/modules/orders/types";
import { compareDecimals, subtractDecimals, sumDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertNoCardNumbers } from "../rules/guest-contact";
import {
  LOYALTY_POINTS_MAX,
  assertValidAdjustment,
  assertValidRates,
  assertValidReason,
  availablePoints,
  pointsEarned,
} from "../rules/loyalty";
import { pointsDueForRefund, pointsToTake, refundNetOfTax } from "../rules/loyalty-refunds";
import { assertPermission } from "./guest-access";
import {
  lockLoyaltyBalance,
  pendingRedemptions,
  postLoyaltyEntry,
  readBalances,
  readLoyaltyProgram,
  redemptionsToPost,
} from "./loyalty-ledger";

// Phase 30 guest loyalty, owned by Reservations (policy 3). The program, rewards, a profile's
// points, adjustments, and the two postings other workflows call: earning when a visit
// finishes (end-table-session) and redeeming when a check closes (close-order).

// ------------------------------------------------------------------ program

export type LoyaltyProgramView = {
  enabled: boolean;
  pointsPerDollar: number;
  pointsPerVisit: number;
  enabledAt: string | null;
  version: number;
};

function programView(program: Awaited<ReturnType<typeof readLoyaltyProgram>>): LoyaltyProgramView {
  return {
    enabled: program.enabled,
    pointsPerDollar: program.pointsPerDollar,
    pointsPerVisit: program.pointsPerVisit,
    enabledAt: program.enabledAt?.toISOString() ?? null,
    version: program.version,
  };
}

/** Anyone who sees guest profiles may see whether the program is on and its rates. */
export async function getLoyaltyProgram(executor: DatabaseExecutor, actor: Actor): Promise<LoyaltyProgramView> {
  if (!actor.permissions.has("loyalty.manage")) {
    assertPermission(actor, "guests.view");
  }

  return programView(await readLoyaltyProgram(executor, actor.organizationId));
}

/**
 * Policy 5: rates apply to visits finishing afterwards. `enabled_at` is set on the first
 * enable and never moves, so visits before it never earn. `expectedVersion` 0 means unsaved.
 */
export async function updateLoyaltyProgram(
  database: Database,
  actor: Actor,
  input: { enabled: boolean; pointsPerDollar: number; pointsPerVisit: number; expectedVersion: number },
): Promise<LoyaltyProgramView> {
  assertPermission(actor, "loyalty.manage");
  assertValidRates(input);

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const [current] = await transaction
      .select()
      .from(guestLoyaltyPrograms)
      .where(eq(guestLoyaltyPrograms.organizationId, actor.organizationId))
      .for("update");

    if ((current?.version ?? 0) !== input.expectedVersion) {
      throw new ConcurrencyError("loyalty program", actor.organizationId);
    }

    const enabledAt = current?.enabledAt ?? (input.enabled ? now : null);
    const values = {
      enabled: input.enabled,
      pointsPerDollar: input.pointsPerDollar,
      pointsPerVisit: input.pointsPerVisit,
      enabledAt,
      updatedByUserId: actor.userId,
      updatedAt: now,
    };
    const [row] = current
      ? await transaction
          .update(guestLoyaltyPrograms)
          .set({ ...values, version: sql`${guestLoyaltyPrograms.version} + 1` })
          .where(eq(guestLoyaltyPrograms.organizationId, actor.organizationId))
          .returning()
      : await transaction
          .insert(guestLoyaltyPrograms)
          .values({ organizationId: actor.organizationId, ...values })
          .returning();

    await recordAudit(transaction, actor, {
      action: "loyalty.program-changed",
      entityId: actor.organizationId,
      before: current
        ? { enabled: current.enabled, pointsPerDollar: current.pointsPerDollar, pointsPerVisit: current.pointsPerVisit }
        : undefined,
      after: { enabled: row!.enabled, pointsPerDollar: row!.pointsPerDollar, pointsPerVisit: row!.pointsPerVisit },
    });

    return programView(row!);
  });
}

// ------------------------------------------------------------------ rewards

export type LoyaltyRewardView = {
  id: string;
  rewardNumber: number;
  name: string;
  pointsCost: number;
  scope: DiscountScope;
  discountType: DiscountType;
  value: string;
  active: boolean;
  version: number;
};

export type LoyaltyRewardInput = {
  name: string;
  pointsCost: number;
  scope: DiscountScope;
  discountType: DiscountType;
  value: string;
};

function rewardColumns() {
  return {
    id: guestLoyaltyRewards.id,
    rewardNumber: guestLoyaltyRewards.rewardNumber,
    name: guestLoyaltyRewards.name,
    pointsCost: guestLoyaltyRewards.pointsCost,
    scope: discountDefinitions.scope,
    discountType: discountDefinitions.discountType,
    value: discountDefinitions.value,
    active: guestLoyaltyRewards.active,
    version: guestLoyaltyRewards.version,
    discountDefinitionId: guestLoyaltyRewards.discountDefinitionId,
  };
}

type RewardRow = LoyaltyRewardView & { discountDefinitionId: string };

function toRewardView(row: RewardRow): LoyaltyRewardView {
  return {
    id: row.id,
    rewardNumber: row.rewardNumber,
    name: row.name,
    pointsCost: row.pointsCost,
    scope: row.scope as DiscountScope,
    discountType: row.discountType as DiscountType,
    value: row.value,
    active: row.active,
    version: row.version,
  };
}

/** Active rewards for redeemers and profile viewers; every reward for managers. */
export async function listLoyaltyRewards(
  executor: DatabaseExecutor,
  actor: Actor,
  options: { includeInactive?: boolean } = {},
): Promise<LoyaltyRewardView[]> {
  const canManage = actor.permissions.has("loyalty.manage");

  if (!canManage && !actor.permissions.has("loyalty.redeem")) {
    assertPermission(actor, "guests.view");
  }

  const rows = await executor
    .select(rewardColumns())
    .from(guestLoyaltyRewards)
    .innerJoin(discountDefinitions, eq(discountDefinitions.id, guestLoyaltyRewards.discountDefinitionId))
    .where(
      and(
        eq(guestLoyaltyRewards.organizationId, actor.organizationId),
        options.includeInactive && canManage ? undefined : eq(guestLoyaltyRewards.active, true),
      ),
    )
    .orderBy(asc(guestLoyaltyRewards.pointsCost), asc(guestLoyaltyRewards.rewardNumber));

  return rows.map((row) => toRewardView(row as RewardRow));
}

export async function readReward(executor: DatabaseExecutor, actor: Actor, rewardId: string): Promise<RewardRow | null> {
  const [row] = await executor
    .select(rewardColumns())
    .from(guestLoyaltyRewards)
    .innerJoin(discountDefinitions, eq(discountDefinitions.id, guestLoyaltyRewards.discountDefinitionId))
    .where(and(eq(guestLoyaltyRewards.id, rewardId), eq(guestLoyaltyRewards.organizationId, actor.organizationId)));

  return (row as RewardRow | undefined) ?? null;
}

function assertValidReward(input: { name: string; pointsCost: number }) {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 80) {
    throw new BusinessRuleError("INVALID_NAME", "Give the reward a name of 1 to 80 characters.");
  }

  if (!Number.isInteger(input.pointsCost) || input.pointsCost <= 0 || input.pointsCost > LOYALTY_POINTS_MAX) {
    throw new BusinessRuleError("INVALID_POINTS", `A reward costs a whole number of points from 1 to ${LOYALTY_POINTS_MAX}.`);
  }

  assertNoCardNumbers({ name });

  return name;
}

/** Amendment 4: the reward and its own reward-only discount, in one transaction. */
export async function createLoyaltyReward(
  database: Database,
  actor: Actor,
  input: LoyaltyRewardInput,
): Promise<LoyaltyRewardView> {
  assertPermission(actor, "loyalty.manage");

  const name = assertValidReward(input);

  return withTransaction(database, async (transaction) => {
    await transaction
      .insert(guestLoyaltyRewardNumberCounters)
      .values({ organizationId: actor.organizationId, lastNumber: 0 })
      .onConflictDoNothing({ target: guestLoyaltyRewardNumberCounters.organizationId });

    const [counter] = await transaction
      .update(guestLoyaltyRewardNumberCounters)
      .set({ lastNumber: sql`${guestLoyaltyRewardNumberCounters.lastNumber} + 1` })
      .where(eq(guestLoyaltyRewardNumberCounters.organizationId, actor.organizationId))
      .returning({ lastNumber: guestLoyaltyRewardNumberCounters.lastNumber });
    const rewardNumber = counter!.lastNumber;
    const definitionId = await createRewardDiscountDefinition(transaction, actor, {
      code: `LOYALTY-${rewardNumber}`,
      name,
      scope: input.scope,
      discountType: input.discountType,
      value: input.value,
    });
    const [row] = await transaction
      .insert(guestLoyaltyRewards)
      .values({
        organizationId: actor.organizationId,
        rewardNumber,
        name,
        pointsCost: input.pointsCost,
        discountDefinitionId: definitionId,
      })
      .returning({ id: guestLoyaltyRewards.id });
    const reward = (await readReward(transaction, actor, row!.id))!;

    await recordAudit(transaction, actor, {
      action: "loyalty.reward-created",
      entityId: reward.id,
      after: toRewardView(reward),
    });

    return toRewardView(reward);
  });
}

/** Name, cost, value and active change for later redemptions; scope and type are fixed. */
export async function updateLoyaltyReward(
  database: Database,
  actor: Actor,
  rewardId: string,
  input: { name: string; pointsCost: number; value: string; active: boolean; expectedVersion: number },
): Promise<LoyaltyRewardView> {
  assertPermission(actor, "loyalty.manage");

  const name = assertValidReward(input);

  return withTransaction(database, async (transaction) => {
    const [locked] = await transaction
      .select({ id: guestLoyaltyRewards.id, version: guestLoyaltyRewards.version })
      .from(guestLoyaltyRewards)
      .where(and(eq(guestLoyaltyRewards.id, rewardId), eq(guestLoyaltyRewards.organizationId, actor.organizationId)))
      .for("update");

    if (!locked) {
      throw new NotFoundError("loyalty reward");
    }

    if (locked.version !== input.expectedVersion) {
      throw new ConcurrencyError("loyalty reward", rewardId);
    }

    const before = (await readReward(transaction, actor, rewardId))!;

    await updateRewardDiscountDefinition(transaction, actor, before.discountDefinitionId, {
      name,
      value: input.value,
      active: input.active,
    });
    await transaction
      .update(guestLoyaltyRewards)
      .set({
        name,
        pointsCost: input.pointsCost,
        active: input.active,
        version: sql`${guestLoyaltyRewards.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(guestLoyaltyRewards.id, rewardId));

    const after = (await readReward(transaction, actor, rewardId))!;

    await recordAudit(transaction, actor, {
      action: "loyalty.reward-updated",
      entityId: rewardId,
      before: toRewardView(before),
      after: toRewardView(after),
    });

    return toRewardView(after);
  });
}

// ------------------------------------------------------------------ a profile's points

export type LoyaltyEntryView = {
  id: string;
  kind: string;
  points: number;
  balanceAfter: number;
  occurredAt: string;
  businessDate: string | null;
  orderId: string | null;
  orderNumber: number | null;
  guestPartyId: string | null;
  eligibleSubtotal: string | null;
  pointsPerDollar: number | null;
  pointsPerVisit: number | null;
  reason: string | null;
};

export type ProfileLoyaltyView = {
  enabled: boolean;
  balance: number;
  available: number;
  pending: { redemptionId: string; orderId: string; rewardName: string; pointsCost: number }[];
  entries: LoyaltyEntryView[];
};

export async function getProfileLoyalty(
  executor: DatabaseExecutor,
  actor: Actor,
  profileId: string,
): Promise<ProfileLoyaltyView> {
  assertPermission(actor, "guests.view");

  const [profile] = await executor
    .select({ id: guestProfiles.id })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, profileId), eq(guestProfiles.organizationId, actor.organizationId)));

  if (!profile) {
    throw new NotFoundError("guest profile");
  }

  const program = await readLoyaltyProgram(executor, actor.organizationId);
  const balance = (await readBalances(executor, [profileId])).get(profileId) ?? 0;
  const pending = await pendingRedemptions(executor, profileId);
  const entries = await executor
    .select({
      id: guestLoyaltyEntries.id,
      kind: guestLoyaltyEntries.kind,
      points: guestLoyaltyEntries.points,
      balanceAfter: guestLoyaltyEntries.balanceAfter,
      occurredAt: guestLoyaltyEntries.occurredAt,
      businessDate: guestLoyaltyEntries.businessDate,
      orderId: guestLoyaltyEntries.orderId,
      orderNumber: orders.orderNumber,
      guestPartyId: guestLoyaltyEntries.guestPartyId,
      eligibleSubtotal: guestLoyaltyEntries.eligibleSubtotal,
      pointsPerDollar: guestLoyaltyEntries.pointsPerDollarSnapshot,
      pointsPerVisit: guestLoyaltyEntries.pointsPerVisitSnapshot,
      reason: guestLoyaltyEntries.reason,
    })
    .from(guestLoyaltyEntries)
    .leftJoin(orders, eq(orders.id, guestLoyaltyEntries.orderId))
    .where(eq(guestLoyaltyEntries.guestProfileId, profileId))
    .orderBy(desc(guestLoyaltyEntries.sequence))
    .limit(200);

  return {
    enabled: program.enabled,
    balance,
    available: availablePoints(balance, pending.map((row) => row.pointsCost)),
    pending: pending.map((row) => ({
      redemptionId: row.id,
      orderId: row.orderId,
      rewardName: row.rewardName,
      pointsCost: row.pointsCost,
    })),
    entries: entries.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
  };
}

/** Policy 12: a manager adds or removes points with a reason; audited. */
export async function adjustLoyaltyPoints(
  database: Database,
  actor: Actor,
  profileId: string,
  input: { points: number; reason: string },
): Promise<{ balance: number; available: number }> {
  assertPermission(actor, "loyalty.adjust");

  const reason = assertValidReason(input.reason);

  assertNoCardNumbers({ reason });

  return withTransaction(database, async (transaction) => {
    const profile = await lockActiveLoyaltyProfile(transaction, actor, profileId);
    const balance = await lockLoyaltyBalance(transaction, actor.organizationId, profileId);
    const pending = (await pendingRedemptions(transaction, profileId)).map((row) => row.pointsCost);

    assertValidAdjustment(balance, pending, input.points);

    const posted = await postLoyaltyEntry(transaction, actor, profileId, {
      kind: "ADJUSTED",
      points: input.points,
      reason,
    });

    await recordAudit(transaction, actor, {
      action: "loyalty.points-adjusted",
      entityId: profileId,
      details: { profileNumber: profile.profileNumber, points: input.points, balanceAfter: posted.balanceAfter, reason },
    });

    return { balance: posted.balanceAfter, available: availablePoints(posted.balanceAfter, pending) };
  });
}

/** Locks an ACTIVE profile of the actor's organization (amendment 5: only ACTIVE profiles). */
export async function lockActiveLoyaltyProfile(transaction: DatabaseTransaction, actor: Actor, profileId: string) {
  const [profile] = await transaction
    .select({ id: guestProfiles.id, status: guestProfiles.status, profileNumber: guestProfiles.profileNumber })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, profileId), eq(guestProfiles.organizationId, actor.organizationId)))
    .for("share");

  if (!profile) {
    throw new NotFoundError("guest profile");
  }

  if (profile.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "PROFILE_NOT_ACTIVE",
      profile.status === "MERGED" ? "This profile was merged into another." : "This profile was erased.",
    );
  }

  return profile;
}

// ------------------------------------------------------------------ postings for workflows

/**
 * Policy 4: called by `end-table-session` in its transaction, after the party is COMPLETED.
 * Earns once per party when the program is on, the visit finished after it was first
 * enabled, and the party is linked to an ACTIVE profile (amendment 5). Writes nothing when
 * no points are due.
 */
export async function earnPointsForFinishedParty(
  transaction: DatabaseTransaction,
  actor: Actor,
  partyId: string,
  at: Date,
): Promise<{ points: number } | null> {
  const program = await readLoyaltyProgram(transaction, actor.organizationId);

  if (!program.enabled || !program.enabledAt || program.enabledAt > at) {
    return null;
  }

  const [party] = await transaction
    .select({ guestProfileId: guestParties.guestProfileId, status: guestParties.status })
    .from(guestParties)
    .where(eq(guestParties.id, partyId));

  if (!party?.guestProfileId || party.status !== "COMPLETED") {
    return null;
  }

  const [profile] = await transaction
    .select({ status: guestProfiles.status })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, party.guestProfileId), eq(guestProfiles.organizationId, actor.organizationId)))
    .for("share");

  if (profile?.status !== "ACTIVE") {
    return null;
  }

  const [already] = await transaction
    .select({ id: guestLoyaltyEntries.id })
    .from(guestLoyaltyEntries)
    .where(and(eq(guestLoyaltyEntries.guestPartyId, partyId), eq(guestLoyaltyEntries.kind, "EARNED")));

  if (already) {
    return null;
  }

  const closed = await transaction
    .select({ id: orders.id, subtotal: orders.subtotal })
    .from(orders)
    .where(and(eq(orders.guestPartyId, partyId), eq(orders.status, "CLOSED")));
  // Phase 33 (policy 9): refunds already recorded on these checks come off what earns points.
  const refunds =
    closed.length === 0
      ? []
      : await transaction
          .select({ amount: orderRefunds.amount, taxAmount: orderRefunds.taxAmount })
          .from(orderRefunds)
          .where(and(inArray(orderRefunds.orderId, closed.map((row) => row.id)), eq(orderRefunds.status, "RECORDED")));
  const earned = pointsEarned(
    closed.length === 0 ? [] : [netOfRefunds(closed.map((row) => row.subtotal), refunds.map(refundNetOfTax))],
    { pointsPerDollar: program.pointsPerDollar, pointsPerVisit: program.pointsPerVisit },
  );

  if (earned.points <= 0) {
    return null;
  }

  await postLoyaltyEntry(
    transaction,
    actor,
    party.guestProfileId,
    {
      kind: "EARNED",
      points: earned.points,
      guestPartyId: partyId,
      eligibleSubtotal: earned.eligibleSubtotal,
      pointsPerDollarSnapshot: program.pointsPerDollar,
      pointsPerVisitSnapshot: program.pointsPerVisit,
    },
    at,
  );

  return { points: earned.points };
}

/**
 * Policy 9 and amendment 6: called by `close-order` in its transaction, with the order locked.
 * Posts `REDEEMED` for each reward on the check whose discount is still applied with an
 * amount above zero; the rest leave nothing.
 */
export async function postRedemptionsForClosedOrder(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  at: Date,
): Promise<number> {
  const rows = await redemptionsToPost(transaction, orderId);

  for (const row of rows) {
    await postLoyaltyEntry(
      transaction,
      actor,
      row.guestProfileId,
      { kind: "REDEEMED", points: -row.pointsCost, orderId, guestPartyId: row.guestPartyId, redemptionId: row.id },
      at,
    );
  }

  return rows.length;
}

/** Policy 10: refused while a reward on the profile's checks hasn't closed yet. */
export async function assertNoPendingReward(executor: DatabaseExecutor, profileId: string): Promise<void> {
  if ((await pendingRedemptions(executor, profileId)).length > 0) {
    throw new BusinessRuleError(
      "REWARD_PENDING",
      "A loyalty reward is on an open check for this guest. Close or remove it first.",
    );
  }
}

/** Policy 10: merge moves the duplicate's points to the profile kept. Locks in ID order. */
export async function moveLoyaltyBalanceOnMerge(
  transaction: DatabaseTransaction,
  actor: Actor,
  duplicateId: string,
  keptId: string,
  at: Date,
): Promise<number> {
  await assertNoPendingReward(transaction, duplicateId);

  for (const id of [duplicateId, keptId].sort()) {
    await lockLoyaltyBalance(transaction, actor.organizationId, id);
  }

  const points = (await readBalances(transaction, [duplicateId])).get(duplicateId) ?? 0;

  if (points > 0) {
    await postLoyaltyEntry(transaction, actor, duplicateId, { kind: "MERGED_OUT", points: -points, relatedProfileId: keptId }, at);
    await postLoyaltyEntry(transaction, actor, keptId, { kind: "MERGED_IN", points, relatedProfileId: duplicateId }, at);
  }

  return points;
}

/** Policy 10: erase brings the balance to zero; the entries stay. */
export async function clearLoyaltyBalanceOnErase(
  transaction: DatabaseTransaction,
  actor: Actor,
  profileId: string,
  at: Date,
): Promise<number> {
  await assertNoPendingReward(transaction, profileId);

  const points = await lockLoyaltyBalance(transaction, actor.organizationId, profileId);

  if (points > 0) {
    await postLoyaltyEntry(transaction, actor, profileId, { kind: "ERASED", points: -points }, at);
  }

  return points;
}

/**
 * Amendment 7: what the visit of a check earned, for the refund screen. Points are earned per
 * visit, so this is the party's `EARNED` entry. Null without `guests.view` or when none.
 */
export async function getVisitEarningForOrder(executor: DatabaseExecutor, actor: Actor, orderId: string) {
  if (!actor.permissions.has("guests.view")) {
    return null;
  }

  const [row] = await executor
    .select({
      profileId: guestLoyaltyEntries.guestProfileId,
      profileNumber: guestProfiles.profileNumber,
      points: guestLoyaltyEntries.points,
      eligibleSubtotal: guestLoyaltyEntries.eligibleSubtotal,
      pointsPerDollar: guestLoyaltyEntries.pointsPerDollarSnapshot,
      pointsPerVisit: guestLoyaltyEntries.pointsPerVisitSnapshot,
    })
    .from(orders)
    .innerJoin(
      guestLoyaltyEntries,
      and(eq(guestLoyaltyEntries.guestPartyId, orders.guestPartyId), eq(guestLoyaltyEntries.kind, "EARNED")),
    )
    .innerJoin(guestProfiles, eq(guestProfiles.id, guestLoyaltyEntries.guestProfileId))
    .where(and(eq(orders.id, orderId), eq(orders.organizationId, actor.organizationId)));

  return row ?? null;
}

/** The checks' subtotals less refunds, never below zero. */
function netOfRefunds(subtotals: readonly string[], refunds: readonly string[]): string {
  const net = subtractDecimals(sumDecimals(subtotals, 2), sumDecimals(refunds, 2));

  return compareDecimals(net, "0") < 0 ? "0.00" : net;
}

// ------------------------------------------------------------------ refunds (Phase 33)

/** Points a refund took back, and those it couldn't (policy 8). */
export type RefundPoints = { taken: number; short: number };

/**
 * Policy 11: the profile now holding a visit's points: the one it was earned on, or the
 * profile that one was merged into, following the chain. Null once erased.
 */
async function currentHolder(transaction: DatabaseTransaction, organizationId: string, profileId: string): Promise<string | null> {
  let id = profileId;

  for (let hop = 0; hop < 100; hop += 1) {
    const [profile] = await transaction
      .select({ status: guestProfiles.status, mergedInto: guestProfiles.mergedIntoProfileId })
      .from(guestProfiles)
      .where(and(eq(guestProfiles.id, id), eq(guestProfiles.organizationId, organizationId)))
      .for("share");

    if (!profile || profile.status === "ERASED") {
      return null;
    }

    if (profile.status !== "MERGED" || !profile.mergedInto) {
      return id;
    }

    id = profile.mergedInto;
  }

  return null;
}

/**
 * Phase 33 (policies 7, 8, 11): called by the `record-refund` workflow in its transaction,
 * after the refund row is written. Takes back the points the refunded amount (before tax)
 * paid for, on the visit's running total, from the profile now holding them, no further than
 * the points the guest can spend. A visit that earned nothing, or whose profile was erased,
 * gets no entry. Runs whether or not the program is still on.
 */
export async function reversePointsForRefund(
  transaction: DatabaseTransaction,
  actor: Actor,
  refund: { id: string; orderId: string; amount: string; taxAmount: string },
  at: Date,
): Promise<RefundPoints> {
  const [order] = await transaction
    .select({ guestPartyId: orders.guestPartyId })
    .from(orders)
    .where(and(eq(orders.id, refund.orderId), eq(orders.organizationId, actor.organizationId)));

  if (!order?.guestPartyId) {
    return { taken: 0, short: 0 };
  }

  const [earnedEntry] = await transaction
    .select({
      profileId: guestLoyaltyEntries.guestProfileId,
      eligibleSubtotal: guestLoyaltyEntries.eligibleSubtotal,
      pointsPerDollar: guestLoyaltyEntries.pointsPerDollarSnapshot,
      occurredAt: guestLoyaltyEntries.occurredAt,
    })
    .from(guestLoyaltyEntries)
    .where(and(eq(guestLoyaltyEntries.guestPartyId, order.guestPartyId), eq(guestLoyaltyEntries.kind, "EARNED")));

  // Policy 9: before the visit earned, earning itself leaves refunds out.
  if (!earnedEntry?.eligibleSubtotal || earnedEntry.pointsPerDollar === null) {
    return { taken: 0, short: 0 };
  }

  // The visit's other refunds recorded since it earned (those before are already left out).
  const earlier = await transaction
    .select({ amount: orderRefunds.amount, taxAmount: orderRefunds.taxAmount })
    .from(orderRefunds)
    .innerJoin(orders, eq(orders.id, orderRefunds.orderId))
    .where(
      and(
        eq(orders.guestPartyId, order.guestPartyId),
        eq(orderRefunds.status, "RECORDED"),
        gt(orderRefunds.recordedAt, earnedEntry.occurredAt),
        ne(orderRefunds.id, refund.id),
      ),
    );
  const due = pointsDueForRefund(
    { eligibleSubtotal: earnedEntry.eligibleSubtotal, pointsPerDollar: earnedEntry.pointsPerDollar },
    earlier.map(refundNetOfTax),
    refundNetOfTax(refund),
  );

  if (due <= 0) {
    return { taken: 0, short: 0 };
  }

  const holder = await currentHolder(transaction, actor.organizationId, earnedEntry.profileId);

  if (!holder) {
    return { taken: 0, short: 0 };
  }

  const balance = await lockLoyaltyBalance(transaction, actor.organizationId, holder);
  const pending = (await pendingRedemptions(transaction, holder)).map((row) => row.pointsCost);
  const result = pointsToTake(due, balance, pending);

  if (result.taken > 0) {
    await postLoyaltyEntry(
      transaction,
      actor,
      holder,
      { kind: "REFUND_REVERSED", points: -result.taken, refundId: refund.id, orderId: refund.orderId, guestPartyId: order.guestPartyId },
      at,
    );
  }

  return result;
}

/**
 * Phase 33 (policy 10): called by the `void-refund` workflow in its transaction. Puts back
 * exactly what the refund took, onto the profile now holding the visit's points; nothing
 * when it took nothing or that profile was erased.
 */
export async function restorePointsForRefundVoid(
  transaction: DatabaseTransaction,
  actor: Actor,
  refundId: string,
  at: Date,
): Promise<number> {
  const [reversed] = await transaction
    .select({
      profileId: guestLoyaltyEntries.guestProfileId,
      points: guestLoyaltyEntries.points,
      orderId: guestLoyaltyEntries.orderId,
      guestPartyId: guestLoyaltyEntries.guestPartyId,
    })
    .from(guestLoyaltyEntries)
    .where(and(eq(guestLoyaltyEntries.refundId, refundId), eq(guestLoyaltyEntries.kind, "REFUND_REVERSED")));

  if (!reversed) {
    return 0;
  }

  const holder = await currentHolder(transaction, actor.organizationId, reversed.profileId);

  if (!holder) {
    return 0;
  }

  const points = -reversed.points;

  await postLoyaltyEntry(
    transaction,
    actor,
    holder,
    { kind: "REFUND_RESTORED", points, refundId, orderId: reversed.orderId, guestPartyId: reversed.guestPartyId },
    at,
  );

  return points;
}
