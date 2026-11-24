import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getChecklistRun } from "@/modules/restaurant/services/checklist-service";
import { checklistRunIdParamsSchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 5): one checklist run with its items. */
export const GET = apiRoute<{ runId: string }>({ module: "restaurant", operation: "get-checklist-run" }, async ({ params }) => {
  const actor = await requireApiActor();
  const p = parseWith(checklistRunIdParamsSchema, params);

  return { body: await getChecklistRun(getDatabase(), actor, p.runId) };
});
