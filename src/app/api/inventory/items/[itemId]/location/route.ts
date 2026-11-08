import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setItemLocation } from "@/modules/inventory/services/item-service";
import { itemIdParamsSchema, setItemLocationSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "set-item-location" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, setItemLocationSchema);

    return { body: await setItemLocation(db, actor, p.itemId, body) };
  },
);
