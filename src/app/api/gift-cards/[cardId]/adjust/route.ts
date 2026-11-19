import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { adjustGiftCard } from "@/modules/settlements/services/gift-card-service";
import { adjustGiftCardSchema, giftCardIdParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 31 (policy 12): adds or removes value with a reason. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "adjust-gift-card" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, adjustGiftCardSchema);

    return { body: await adjustGiftCard(getDatabase(), actor, p.cardId, body) };
  },
);
