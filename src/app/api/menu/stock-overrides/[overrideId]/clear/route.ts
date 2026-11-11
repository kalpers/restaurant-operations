import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clearSellAnyway } from "@/modules/menu/services/outage-service";
import { overrideIdParamsSchema, versionOnlySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** End a sell-anyway override early (Phase 19, policy A5). */
export const POST = apiRoute<{ overrideId: string }>(
  { module: "menu", operation: "clear-sell-anyway" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { overrideId } = parseWith(overrideIdParamsSchema, params);
    const body = await parseJsonBody(request, versionOnlySchema);

    return { body: await clearSellAnyway(getDatabase(), actor, { overrideId, ...body }) };
  },
);
