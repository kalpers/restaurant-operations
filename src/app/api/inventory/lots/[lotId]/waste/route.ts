import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { wasteLot } from "@/modules/inventory/services/lot-service";
import { lotIdParamsSchema, wasteLotSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 22): wastes everything left in one lot. */
export const POST = apiRoute<{ lotId: string }>(
  { module: "inventory", operation: "waste-lot" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { lotId } = parseWith(lotIdParamsSchema, params);
    const body = await parseJsonBody(request, wasteLotSchema);

    return { body: await wasteLot(getDatabase(), actor, lotId, body), status: 201 };
  },
);
