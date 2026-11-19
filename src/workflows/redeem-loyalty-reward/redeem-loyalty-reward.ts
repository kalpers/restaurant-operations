import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { guestLoyaltyRedemptions, guestParties } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { lockOrder } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { applyDiscountInTransaction } from "@/modules/orders/services/discount-service";
import { assertCanSpend, availablePoints } from "@/modules/reservations/rules/loyalty";
import { assertPermission } from "@/modules/reservations/services/guest-access";
import {
  lockLoyaltyBalance,
  pendingRedemptions,
  readLoyaltyProgram,
} from "@/modules/reservations/services/loyalty-ledger";
import { lockActiveLoyaltyProfile, readReward } from "@/modules/reservations/services/loyalty-service";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

/** Idempotency scope for redeeming a loyalty reward (policy 8). */
export const REDEEM_LOYALTY_SCOPE = "loyalty.redeem";

export type RedeemRewardResult = {
  redemptionId: string;
  discountId: string;
  orderId: string;
  orderVersion: number;
  pointsCost: number;
  /** The guest's points left to spend, with this reward pending. */
  available: number;
};

/**
 * Phase 30 (policies 8, 9; amendment 3): applies a reward to an OPEN check of a party linked to
 * an ACTIVE profile, as an ordinary discount through the discount rules, and records the
 * redemption. The points stay on the balance, pending, until the check closes. Locks the
 * order before the balance, as `close-order` does. A retry with the same key applies nothing
 * more; a refusal writes nothing.
 */
export async function redeemLoyaltyReward(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { rewardId: string; orderItemId?: string; expectedVersion: number; idempotencyKey: string },
): Promise<RedeemRewardResult & { replayed: boolean }> {
  assertPermission(actor, "loyalty.redeem");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<RedeemRewardResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: REDEEM_LOYALTY_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: {
          orderId,
          rewardId: input.rewardId,
          orderItemId: input.orderItemId ?? null,
          expectedVersion: input.expectedVersion,
        },
      },
      async () => {
        const program = await readLoyaltyProgram(transaction, actor.organizationId);

        if (!program.enabled) {
          throw new BusinessRuleError("LOYALTY_NOT_ENABLED", "The loyalty program isn't turned on.");
        }

        const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

        assertOrderOpen(order.status);
        await assertNoOpenSettlement(transaction, order.id);

        const [party] = order.guestPartyId
          ? await transaction
              .select({ id: guestParties.id, guestProfileId: guestParties.guestProfileId })
              .from(guestParties)
              .where(and(eq(guestParties.id, order.guestPartyId), eq(guestParties.locationId, actor.locationId)))
          : [];

        if (!party?.guestProfileId) {
          throw new BusinessRuleError("NO_LINKED_GUEST", "Link a guest profile to this table to use a reward.");
        }

        const profile = await lockActiveLoyaltyProfile(transaction, actor, party.guestProfileId);
        const reward = await readReward(transaction, actor, input.rewardId);

        if (!reward) {
          throw new NotFoundError("loyalty reward");
        }

        if (!reward.active) {
          throw new BusinessRuleError("REWARD_INACTIVE", "That reward isn't active.");
        }

        if (reward.scope === "ITEM" && !input.orderItemId) {
          throw new BusinessRuleError("REWARD_NEEDS_ITEM", "Choose the item this reward is for.");
        }

        if (reward.scope === "ORDER" && input.orderItemId) {
          throw new BusinessRuleError("DISCOUNT_SCOPE_MISMATCH", "That reward applies to the whole check.");
        }

        const balance = await lockLoyaltyBalance(transaction, actor.organizationId, profile.id);
        const pending = (await pendingRedemptions(transaction, profile.id)).map((row) => row.pointsCost);

        assertCanSpend(balance, pending, reward.pointsCost);

        const applied = await applyDiscountInTransaction(
          transaction,
          actor,
          order.id,
          {
            discountDefinitionId: reward.discountDefinitionId,
            reason: `Loyalty: ${reward.name}`,
            expectedVersion: order.version,
            orderItemId: input.orderItemId,
          },
          { allowRewardOnly: true },
        );
        const now = new Date();
        const [row] = await transaction
          .insert(guestLoyaltyRedemptions)
          .values({
            organizationId: actor.organizationId,
            rewardId: reward.id,
            guestProfileId: profile.id,
            guestPartyId: party.id,
            orderId: order.id,
            orderDiscountId: applied.scope === "ORDER" ? applied.discountId : null,
            orderItemDiscountId: applied.scope === "ITEM" ? applied.discountId : null,
            rewardNameSnapshot: reward.name,
            pointsCostSnapshot: reward.pointsCost,
            redeemedByUserId: actor.userId,
            redeemedAt: now,
          })
          .returning({ id: guestLoyaltyRedemptions.id });

        await recordAudit(transaction, actor, {
          action: "loyalty.reward-redeemed",
          entityId: profile.id,
          occurredAt: now,
          details: {
            profileNumber: profile.profileNumber,
            rewardNumber: reward.rewardNumber,
            pointsCost: reward.pointsCost,
            orderId: order.id,
            orderItemId: input.orderItemId ?? null,
            discountId: applied.discountId,
          },
        });

        return {
          redemptionId: row!.id,
          discountId: applied.discountId,
          orderId: order.id,
          orderVersion: applied.orderVersion,
          pointsCost: reward.pointsCost,
          available: availablePoints(balance, [...pending, reward.pointsCost]),
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
