import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createPlacement, listPlacements } from "@/modules/menu/services/catalog-service";
import { createPlacementSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-placements" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const url = new URL(request.url);

    return { body: await listPlacements(db, actor, { menuId: url.searchParams.get("menuId") ?? undefined, menuItemId: url.searchParams.get("menuItemId") ?? undefined }) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-placement" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createPlacementSchema);

    return { body: await createPlacement(db, actor, body), status: 201 };
  },
);
