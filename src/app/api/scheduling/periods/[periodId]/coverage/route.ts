import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getPeriodCoverage } from "@/modules/scheduling/services/coverage-service";
import { periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "get-coverage" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const db = getDatabase();

    return { body: await getPeriodCoverage(db, actor, p.periodId) };
  },
);
