import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { correctLot } from "@/modules/inventory/services/lot-service";
import { correctLotSchema, lotIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 21): corrects a lot's supplier code or use-by date, with a reason. */
export const PATCH = apiRoute<{ lotId: string }>(
  { module: "inventory", operation: "correct-lot" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { lotId } = parseWith(lotIdParamsSchema, params);
    const body = await parseJsonBody(request, correctLotSchema);

    return { body: await correctLot(getDatabase(), actor, lotId, body) };
  },
);
