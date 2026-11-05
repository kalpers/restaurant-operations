import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listGenerationRuns } from "@/modules/scheduling/services/generation-service";
import { periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "list-generation-runs" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const db = getDatabase();

    return { body: { runs: await listGenerationRuns(db, actor, p.periodId) } };
  },
);
