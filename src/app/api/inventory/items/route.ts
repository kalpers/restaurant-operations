import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createItem, listItems } from "@/modules/inventory/services/item-service";
import { createItemSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "list-items" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listItems(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "inventory", operation: "create-item" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createItemSchema);

    return { body: await createItem(db, actor, body), status: 201 };
  },
);
