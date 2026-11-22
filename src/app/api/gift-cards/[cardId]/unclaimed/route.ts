import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { reportGiftCardUnclaimed } from "@/modules/settlements/services/gift-card-unclaimed-service";
import { giftCardIdParamsSchema, reportUnclaimedSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 6): records the balance as reported to a state and paid over. Never undone. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "report-gift-card-unclaimed" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { cardId } = parseWith(giftCardIdParamsSchema, params);
    const body = await parseJsonBody(request, reportUnclaimedSchema);

    return { body: await reportGiftCardUnclaimed(getDatabase(), actor, cardId, body), status: 201 };
  },
);
