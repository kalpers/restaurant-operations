import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateLoyaltyReward } from "@/modules/reservations/services/loyalty-service";
import {
  loyaltyRewardIdParamsSchema,
  updateLoyaltyRewardSchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 30 (policy 7, amendment 4): change a reward and its discount for later redemptions. */
export const PATCH = apiRoute<{ rewardId: string }>(
  { module: "reservations", operation: "update-loyalty-reward" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { rewardId } = parseWith(loyaltyRewardIdParamsSchema, params);
    const body = await parseJsonBody(request, updateLoyaltyRewardSchema);

    return { body: await updateLoyaltyReward(getDatabase(), actor, rewardId, body) };
  },
);
