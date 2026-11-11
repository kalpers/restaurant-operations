import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { restoreItem } from "@/modules/menu/services/outage-service";
import { outageIdParamsSchema, versionOnlySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Restore an 86'd item (Phase 19, policy A2). */
export const POST = apiRoute<{ outageId: string }>(
  { module: "menu", operation: "restore-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { outageId } = parseWith(outageIdParamsSchema, params);
    const body = await parseJsonBody(request, versionOnlySchema);

    return { body: await restoreItem(getDatabase(), actor, { outageId, ...body }) };
  },
);
