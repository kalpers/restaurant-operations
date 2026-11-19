import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { replaceGiftCardCode } from "@/modules/settlements/services/gift-card-service";
import {
  giftCardIdParamsSchema,
  replaceGiftCardCodeSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 31 (policy 12): a new code for a lost card, in this response only and never cached. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "replace-gift-card-code" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, replaceGiftCardCodeSchema);
    const result = await replaceGiftCardCode(getDatabase(), actor, p.cardId, body);

    return { response: Response.json(result, { headers: { "Cache-Control": "no-store" } }) };
  },
);
