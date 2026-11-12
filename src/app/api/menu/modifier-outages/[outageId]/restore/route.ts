import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { restoreModifier } from "@/modules/menu/services/outage-service";
import { outageIdParamsSchema, versionOnlySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Restore an 86'd modifier, or cancel a scheduled one (Phase 20, policy 3). */
export const POST = apiRoute<{ outageId: string }>(
  { module: "menu", operation: "restore-modifier" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { outageId } = parseWith(outageIdParamsSchema, params);
    const body = await parseJsonBody(request, versionOnlySchema);

    return { body: await restoreModifier(getDatabase(), actor, { outageId, ...body }) };
  },
);
