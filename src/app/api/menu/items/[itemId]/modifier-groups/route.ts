import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { attachGroup, listItemAttachments } from "@/modules/menu/services/modifier-service";
import { attachGroupSchema, itemIdParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "list-attachments" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);

    return { body: await listItemAttachments(db, actor, p.itemId) };
  },
);

export const POST = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "attach-group" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, attachGroupSchema);

    return { body: await attachGroup(db, actor, p.itemId, body), status: 201 };
  },
);
