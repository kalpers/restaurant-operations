import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getItemConfiguration, updateItem } from "@/modules/inventory/services/item-service";
import { itemIdParamsSchema, updateItemSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "get-item" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);

    return { body: await getItemConfiguration(db, actor, p.itemId) };
  },
);

export const PATCH = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "update-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, updateItemSchema);

    return { body: await updateItem(db, actor, p.itemId, body) };
  },
);
