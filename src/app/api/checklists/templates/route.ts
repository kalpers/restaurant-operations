import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createChecklistTemplate, listChecklistTemplates } from "@/modules/restaurant/services/checklist-service";
import { createChecklistTemplateSchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 36 (policy 5): the location's checklist templates, for managers. */
export const GET = apiRoute({ module: "restaurant", operation: "list-checklist-templates" }, async () => {
  const actor = await requireApiActor();

  return { body: { templates: await listChecklistTemplates(getDatabase(), actor) } };
});

export const POST = apiRoute({ module: "restaurant", operation: "create-checklist-template" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createChecklistTemplateSchema);

  return { body: await createChecklistTemplate(getDatabase(), actor, body), status: 201 };
});
