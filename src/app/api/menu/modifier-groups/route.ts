import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createGroup, listGroups } from "@/modules/menu/services/modifier-service";
import { createGroupSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-groups" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listGroups(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-group" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createGroupSchema);

    return { body: await createGroup(db, actor, body), status: 201 };
  },
);
