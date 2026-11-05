import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createTemplate, listTemplates } from "@/modules/scheduling/services/config-service";
import { createTemplateSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "list-templates" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: { templates: await listTemplates(db, actor) } };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "create-template" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createTemplateSchema);
    const db = getDatabase();

    return { body: await createTemplate(db, actor, body), status: 201 };
  },
);
