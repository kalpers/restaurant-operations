import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addAvailabilityWindow, listAvailabilityWindows } from "@/modules/menu/services/catalog-service";
import { addAvailabilityWindowSchema, menuIdParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ menuId: string }>(
  { module: "menu", operation: "list-availability" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(menuIdParamsSchema, params);

    return { body: await listAvailabilityWindows(db, actor, p.menuId) };
  },
);

export const POST = apiRoute<{ menuId: string }>(
  { module: "menu", operation: "add-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(menuIdParamsSchema, params);
    const body = await parseJsonBody(request, addAvailabilityWindowSchema);

    return { body: await addAvailabilityWindow(db, actor, p.menuId, body), status: 201 };
  },
);
