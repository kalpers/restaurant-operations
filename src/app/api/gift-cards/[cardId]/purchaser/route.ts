import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getPurchaser, savePurchaser } from "@/modules/settlements/services/gift-card-purchaser-service";
import { giftCardIdParamsSchema, savePurchaserSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 4): who bought the card, for `gift-cards.purchaser.view` holders. Not cached. */
export const GET = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "gift-card-purchaser" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { cardId } = parseWith(giftCardIdParamsSchema, params);

    return { response: Response.json(await getPurchaser(getDatabase(), actor, cardId), { headers: { "Cache-Control": "no-store" } }) };
  },
);

/** Phase 34 (policy 3): adds or changes the details (`gift-cards.manage`). */
export const PUT = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "save-gift-card-purchaser" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { cardId } = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, savePurchaserSchema);

    return { response: Response.json(await savePurchaser(getDatabase(), actor, cardId, body), { headers: { "Cache-Control": "no-store" } }) };
  },
);
