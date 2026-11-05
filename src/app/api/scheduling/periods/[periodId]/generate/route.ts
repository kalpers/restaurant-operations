import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { runGeneration } from "@/modules/scheduling/services/generation-service";
import { generateSchema, periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "generate-schedule" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, generateSchema);
    const db = getDatabase();

    return { body: await runGeneration(db, actor, p.periodId, body) };
  },
);
