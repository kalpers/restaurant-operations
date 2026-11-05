import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { expectedVersionSchema, periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "publish-period" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    return { body: await publishPeriod(db, actor, p.periodId, body) };
  },
);
