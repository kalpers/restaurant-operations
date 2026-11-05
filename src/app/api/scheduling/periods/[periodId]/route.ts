import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getPeriodDetail, updatePeriod } from "@/modules/scheduling/services/schedule-service";
import { periodIdParamsSchema, updatePeriodSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "get-period" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const db = getDatabase();

    return { body: await getPeriodDetail(db, actor, p.periodId) };
  },
);

export const PATCH = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "update-period" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, updatePeriodSchema);
    const db = getDatabase();

    return { body: await updatePeriod(db, actor, p.periodId, body) };
  },
);
