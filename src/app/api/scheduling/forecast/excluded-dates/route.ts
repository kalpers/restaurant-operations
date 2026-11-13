import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addExcludedDate } from "@/modules/scheduling/services/forecast-service";
import { excludedDateSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 24 policy 6: keeps a date out of forecast history. */
export const POST = apiRoute(
  { module: "scheduling", operation: "exclude-forecast-date" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, excludedDateSchema);
    const db = getDatabase();

    return { body: await addExcludedDate(db, actor, body), status: 201 };
  },
);
