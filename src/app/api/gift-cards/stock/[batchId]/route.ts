import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listStockBatchCards } from "@/modules/settlements/services/gift-card-stock-service";
import { giftCardStockBatchParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 10): the cards of one stock batch, by number (never a code). */
export const GET = apiRoute<{ batchId: string }>(
  { module: "settlements", operation: "list-gift-card-stock-cards" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { batchId } = parseWith(giftCardStockBatchParamsSchema, params);

    return { body: { cards: await listStockBatchCards(getDatabase(), actor, batchId) } };
  },
);
