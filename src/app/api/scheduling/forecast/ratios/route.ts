import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createRatio, getForecastSettings } from "@/modules/scheduling/services/forecast-service";
import { createRatioSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 24 policies 6-7: staffing ratios and excluded dates. */
export const GET = apiRoute(
  { module: "scheduling", operation: "get-forecast-settings" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await getForecastSettings(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "create-staffing-ratio" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createRatioSchema);
    const db = getDatabase();

    return { body: await createRatio(db, actor, body), status: 201 };
  },
);
