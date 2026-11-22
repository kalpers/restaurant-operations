import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { deactivateStock } from "@/modules/settlements/services/gift-card-stock-service";
import { deactivateStockSchema, giftCardStockBatchParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 10): deactivates one unsold card, or everything left in the batch. */
export const POST = apiRoute<{ batchId: string }>(
  { module: "settlements", operation: "deactivate-gift-card-stock" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { batchId } = parseWith(giftCardStockBatchParamsSchema, params);
    const body = await parseJsonBody(request, deactivateStockSchema);

    return { body: await deactivateStock(getDatabase(), actor, batchId, body) };
  },
);
