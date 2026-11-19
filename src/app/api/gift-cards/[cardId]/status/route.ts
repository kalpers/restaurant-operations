import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setGiftCardStatus } from "@/modules/settlements/services/gift-card-service";
import { giftCardIdParamsSchema, giftCardStatusSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 31 (policy 12): deactivates or reactivates a card; its balance stays. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "set-gift-card-status" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, giftCardStatusSchema);

    return { body: await setGiftCardStatus(getDatabase(), actor, p.cardId, body) };
  },
);
