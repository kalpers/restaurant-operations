import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createMenu, listMenus } from "@/modules/menu/services/catalog-service";
import { createMenuSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-menus" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listMenus(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-menu" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createMenuSchema);

    return { body: await createMenu(db, actor, body), status: 201 };
  },
);
