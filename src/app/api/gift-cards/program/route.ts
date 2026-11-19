import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getGiftCardProgram, updateGiftCardProgram } from "@/modules/settlements/services/gift-card-service";
import { giftCardProgramSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 31 (policy 8): the organization's gift card settings. */
export const GET = apiRoute({ module: "settlements", operation: "gift-card-program" }, async () => {
  const actor = await requireApiActor();

  return { body: await getGiftCardProgram(getDatabase(), actor) };
});

export const PUT = apiRoute({ module: "settlements", operation: "update-gift-card-program" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, giftCardProgramSchema);

  return { body: await updateGiftCardProgram(getDatabase(), actor, body) };
});
