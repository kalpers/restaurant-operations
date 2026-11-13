import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getPeriodForecast } from "@/modules/scheduling/services/forecast-service";
import { periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 24 policy 10: the forecast preview. Stores nothing. */
export const GET = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "get-forecast" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const db = getDatabase();

    return { body: await getPeriodForecast(db, actor, p.periodId) };
  },
);
