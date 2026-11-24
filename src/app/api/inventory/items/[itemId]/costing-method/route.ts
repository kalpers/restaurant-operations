import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { changeCostingMethod } from "@/modules/inventory/services/costing-method-service";
import { costingMethodSchema, itemIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 37 (policies 2 and 3): changes an item's costing method; stock value carries over. */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "set-costing-method" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(itemIdParamsSchema, params);
    const input = await parseJsonBody(request, costingMethodSchema);

    return { body: await changeCostingMethod(getDatabase(), actor, itemId, input) };
  },
);
