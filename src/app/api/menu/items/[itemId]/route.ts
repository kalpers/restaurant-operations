import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getItem, updateItem } from "@/modules/menu/services/catalog-service";
import { itemIdParamsSchema, updateItemSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "get-item" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);

    return { body: await getItem(db, actor, p.itemId) };
  },
);

export const PATCH = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "update-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, updateItemSchema);

    return { body: await updateItem(db, actor, p.itemId, body) };
  },
);
