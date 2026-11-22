import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clearPurchaser } from "@/modules/settlements/services/gift-card-purchaser-service";
import { clearPurchaserSchema, giftCardIdParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 4): clears the purchaser details for good. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "clear-gift-card-purchaser" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { cardId } = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, clearPurchaserSchema);

    return { response: Response.json(await clearPurchaser(getDatabase(), actor, cardId, body), { headers: { "Cache-Control": "no-store" } }) };
  },
);
