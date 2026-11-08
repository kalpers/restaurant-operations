import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateMenu } from "@/modules/menu/services/catalog-service";
import { menuIdParamsSchema, updateMenuSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ menuId: string }>(
  { module: "menu", operation: "update-menu" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(menuIdParamsSchema, params);
    const body = await parseJsonBody(request, updateMenuSchema);

    return { body: await updateMenu(db, actor, p.menuId, body) };
  },
);
