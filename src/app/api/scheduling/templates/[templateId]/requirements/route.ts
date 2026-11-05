import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addRequirement } from "@/modules/scheduling/services/config-service";
import { requirementSchema, templateIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ templateId: string }>(
  { module: "scheduling", operation: "add-requirement" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(templateIdParamsSchema, params);
    const body = await parseJsonBody(request, requirementSchema);
    const db = getDatabase();

    return { body: await addRequirement(db, actor, p.templateId, body), status: 201 };
  },
);
