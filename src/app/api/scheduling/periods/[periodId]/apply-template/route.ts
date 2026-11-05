import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { applyTemplate } from "@/modules/scheduling/services/config-service";
import { applyTemplateSchema, periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "apply-template" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, applyTemplateSchema);
    const db = getDatabase();

    return { body: await applyTemplate(db, actor, p.periodId, body) };
  },
);
