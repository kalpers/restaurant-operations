import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidGiftCardSale } from "@/modules/settlements/services/gift-card-service";
import {
  giftCardSaleParamsSchema,
  voidGiftCardSaleSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 31 (policy 11): voids a mistaken sale while the card still holds all of it. */
export const POST = apiRoute<{ saleId: string }>(
  { module: "settlements", operation: "void-gift-card-sale" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardSaleParamsSchema, params);
    const body = await parseJsonBody(request, voidGiftCardSaleSchema);

    return { body: await voidGiftCardSale(getDatabase(), actor, p.saleId, body) };
  },
);
