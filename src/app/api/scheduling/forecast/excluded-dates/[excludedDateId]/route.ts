import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeExcludedDate } from "@/modules/scheduling/services/forecast-service";
import { excludedDateIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ excludedDateId: string }>(
  { module: "scheduling", operation: "restore-forecast-date" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(excludedDateIdParamsSchema, params);
    const db = getDatabase();

    await removeExcludedDate(db, actor, p.excludedDateId);

    return {};
  },
);
