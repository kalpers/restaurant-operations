import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getGiftCardHistory } from "@/modules/settlements/services/gift-card-service";
import { giftCardIdParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 31: a card with its ledger and sales. */
export const GET = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "gift-card-history" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardIdParamsSchema, params);

    return { body: await getGiftCardHistory(getDatabase(), actor, p.cardId) };
  },
);
