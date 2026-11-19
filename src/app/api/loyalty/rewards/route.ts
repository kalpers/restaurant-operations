import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createLoyaltyReward, listLoyaltyRewards } from "@/modules/reservations/services/loyalty-service";
import {
  createLoyaltyRewardSchema,
  listLoyaltyRewardsQuerySchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 30 (policy 7): loyalty rewards. Managers see inactive ones too. */
export const GET = apiRoute({ module: "reservations", operation: "loyalty-rewards" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(listLoyaltyRewardsQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: { rewards: await listLoyaltyRewards(getDatabase(), actor, query) } };
});

export const POST = apiRoute({ module: "reservations", operation: "create-loyalty-reward" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createLoyaltyRewardSchema);

  return { status: 201, body: await createLoyaltyReward(getDatabase(), actor, body) };
});
