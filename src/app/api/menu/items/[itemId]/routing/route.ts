import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listItemRouting, setItemRouting } from "@/modules/menu/services/prep-station-service";
import { itemIdParamsSchema, setRoutingSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "list-routing" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);

    return { body: await listItemRouting(db, actor, p.itemId) };
  },
);

export const PUT = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "set-routing" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, setRoutingSchema);

    return { body: await setItemRouting(db, actor, p.itemId, body) };
  },
);
