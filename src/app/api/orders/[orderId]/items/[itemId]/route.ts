import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeDraftItem, updateDraftItem } from "@/modules/orders/services/draft-item-service";
import {
  expectedVersionSchema,
  orderItemParamsSchema,
  updateDraftItemSchema,
} from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

type Params = { orderId: string; itemId: string };

export const PATCH = apiRoute<Params>(
  { module: "orders", operation: "update-draft-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const body = await parseJsonBody(request, updateDraftItemSchema);

    return { body: await updateDraftItem(getDatabase(), actor, p.orderId, p.itemId, body) };
  },
);

export const DELETE = apiRoute<Params>(
  { module: "orders", operation: "remove-draft-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await removeDraftItem(getDatabase(), actor, p.orderId, p.itemId, body) };
  },
);
