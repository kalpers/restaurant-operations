import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createItem, listItems } from "@/modules/menu/services/catalog-service";
import { createItemSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-items" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listItems(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-item" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createItemSchema);

    return { body: await createItem(db, actor, body), status: 201 };
  },
);
