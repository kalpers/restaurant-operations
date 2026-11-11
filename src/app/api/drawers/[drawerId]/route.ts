import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateDrawer } from "@/modules/settlements/services/drawer-service";
import { drawerIdParamsSchema, updateDrawerSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ drawerId: string }>(
  { module: "settlements", operation: "update-drawer" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(drawerIdParamsSchema, params);
    const body = await parseJsonBody(request, updateDrawerSchema);

    return { body: await updateDrawer(getDatabase(), actor, p.drawerId, body) };
  },
);
