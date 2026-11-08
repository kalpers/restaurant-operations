import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setMenuLocation } from "@/modules/menu/services/catalog-service";
import { menuIdParamsSchema, setMenuLocationSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ menuId: string }>(
  { module: "menu", operation: "set-menu-location" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(menuIdParamsSchema, params);
    const body = await parseJsonBody(request, setMenuLocationSchema);

    return { body: await setMenuLocation(db, actor, p.menuId, body) };
  },
);
