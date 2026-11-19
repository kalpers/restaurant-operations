import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { redeemLoyaltyRewardSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { redeemLoyaltyReward } from "@/workflows/redeem-loyalty-reward/redeem-loyalty-reward";

/** Phase 30 (policy 8): redeem the linked guest's reward on this check. */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "redeem-loyalty-reward" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(redeemLoyaltyRewardSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await redeemLoyaltyReward(getDatabase(), actor, p.orderId, body) };
  },
);
