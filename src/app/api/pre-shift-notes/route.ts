import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { createNote, listNotesForManager } from "@/modules/restaurant/services/pre-shift-service";
import { createNoteSchema, noteRangeSchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 32 (policy 9): every note in a range, for managers. */
export const GET = apiRoute({ module: "restaurant", operation: "list-pre-shift-notes" }, async ({ request }) => {
  const actor = await requireApiActor();
  const range = parseWith(noteRangeSchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: await listNotesForManager(getDatabase(), actor, range) };
});

/** Phase 32 (policy 7): a note for today or up to 14 days ahead. */
export const POST = apiRoute({ module: "restaurant", operation: "create-pre-shift-note" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createNoteSchema);

  return { body: await createNote(getDatabase(), actor, body), status: 201 };
});
