import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateDiscountDefinition } from "@/modules/orders/services/discount-service";
import {
  discountDefinitionParamsSchema,
  updateDiscountDefinitionSchema,
} from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ definitionId: string }>(
  { module: "orders", operation: "update-discount" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(discountDefinitionParamsSchema, params);
    const body = await parseJsonBody(request, updateDiscountDefinitionSchema);

    return { body: await updateDiscountDefinition(getDatabase(), actor, p.definitionId, body) };
  },
);
