import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateNote } from "@/modules/restaurant/services/pre-shift-service";
import { noteIdParamsSchema, updateNoteSchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 32 (policy 8): edits a note until its date has passed. */
export const PATCH = apiRoute<{ noteId: string }>(
  { module: "restaurant", operation: "update-pre-shift-note" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(noteIdParamsSchema, params);
    const body = await parseJsonBody(request, updateNoteSchema);

    return { body: await updateNote(getDatabase(), actor, p.noteId, body) };
  },
);
