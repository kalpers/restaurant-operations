import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { listChecklistHistory } from "@/modules/restaurant/services/checklist-service";
import { checklistHistoryQuerySchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 5): what happened on each date, up to 31 days. */
export const GET = apiRoute({ module: "restaurant", operation: "list-checklist-history" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(checklistHistoryQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: await listChecklistHistory(getDatabase(), actor, query) };
});
