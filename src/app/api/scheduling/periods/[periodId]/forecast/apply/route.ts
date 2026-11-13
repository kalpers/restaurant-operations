import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { applyForecastSuggestions } from "@/modules/scheduling/services/forecast-service";
import {
  applyForecastSchema,
  periodIdParamsSchema,
} from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 24 policy 13: sets template shifts to their forecast suggestion. */
export const POST = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "apply-forecast" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, applyForecastSchema);
    const db = getDatabase();

    return { body: await applyForecastSuggestions(db, actor, p.periodId, body) };
  },
);
