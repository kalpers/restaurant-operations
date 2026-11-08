import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updatePlacement } from "@/modules/menu/services/catalog-service";
import { placementIdParamsSchema, updatePlacementSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ placementId: string }>(
  { module: "menu", operation: "update-placement" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(placementIdParamsSchema, params);
    const body = await parseJsonBody(request, updatePlacementSchema);

    return { body: await updatePlacement(db, actor, p.placementId, body) };
  },
);
