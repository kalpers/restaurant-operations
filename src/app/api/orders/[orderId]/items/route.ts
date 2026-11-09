import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { addDraftItemSchema, orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "add-draft-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, addDraftItemSchema);

    return { body: await addDraftItem(getDatabase(), actor, p.orderId, body), status: 201 };
  },
);
