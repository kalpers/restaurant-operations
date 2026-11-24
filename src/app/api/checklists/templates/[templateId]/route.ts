import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateChecklistTemplate } from "@/modules/restaurant/services/checklist-service";
import {
  checklistTemplateIdParamsSchema,
  updateChecklistTemplateSchema,
} from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 5): edits a template; started runs keep their own copy. */
export const PATCH = apiRoute<{ templateId: string }>(
  { module: "restaurant", operation: "update-checklist-template" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(checklistTemplateIdParamsSchema, params);
    const body = await parseJsonBody(request, updateChecklistTemplateSchema);

    return { body: await updateChecklistTemplate(getDatabase(), actor, p.templateId, body) };
  },
);
