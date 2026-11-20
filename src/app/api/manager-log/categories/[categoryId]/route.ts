import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateLogCategory } from "@/modules/restaurant/services/manager-log-category-service";
import { logCategoryIdParamsSchema, updateLogCategorySchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 33 (policy 18): rename, reorder, deactivate or reactivate a category. */
export const PATCH = apiRoute<{ categoryId: string }>(
  { module: "restaurant", operation: "update-manager-log-category" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(logCategoryIdParamsSchema, params);
    const body = await parseJsonBody(request, updateLogCategorySchema);

    return { body: await updateLogCategory(getDatabase(), actor, p.categoryId, body) };
  },
);
