import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { lookUpGiftCard } from "@/modules/settlements/services/gift-card-service";
import { lookUpGiftCardSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 31: finds a card by its code (in the body, never the URL) or, for managers, its number. */
export const POST = apiRoute({ module: "settlements", operation: "look-up-gift-card" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, lookUpGiftCardSchema);

  return { body: await lookUpGiftCard(getDatabase(), actor, body) };
});
