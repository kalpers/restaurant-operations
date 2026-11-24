import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { signOffChecklistRun } from "@/modules/restaurant/services/checklist-service";
import { checklistRunIdParamsSchema, checklistRunVersionSchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 5): a manager other than the completer signs a run off. */
export const POST = apiRoute<{ runId: string }>(
  { module: "restaurant", operation: "sign-off-checklist-run" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(checklistRunIdParamsSchema, params);
    const body = await parseJsonBody(request, checklistRunVersionSchema);

    return { body: await signOffChecklistRun(getDatabase(), actor, p.runId, body) };
  },
);
