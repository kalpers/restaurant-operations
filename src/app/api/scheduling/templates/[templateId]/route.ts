import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateTemplate } from "@/modules/scheduling/services/config-service";
import { templateIdParamsSchema, updateTemplateSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ templateId: string }>(
  { module: "scheduling", operation: "update-template" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(templateIdParamsSchema, params);
    const body = await parseJsonBody(request, updateTemplateSchema);
    const db = getDatabase();

    return { body: await updateTemplate(db, actor, p.templateId, body) };
  },
);
