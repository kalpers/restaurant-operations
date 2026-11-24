import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listChecklistsToday, startChecklistRun } from "@/modules/restaurant/services/checklist-service";
import { startChecklistRunSchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 36 (policy 5): today's checklists for the reader. */
export const GET = apiRoute({ module: "restaurant", operation: "list-checklists-today" }, async () => {
  const actor = await requireApiActor();

  return { body: await listChecklistsToday(getDatabase(), actor) };
});

/** Starts today's run of a template (or returns the one already started). */
export const POST = apiRoute({ module: "restaurant", operation: "start-checklist-run" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, startChecklistRunSchema);

  return { body: await startChecklistRun(getDatabase(), actor, body), status: 201 };
});
