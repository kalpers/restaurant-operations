import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { withdrawNote } from "@/modules/restaurant/services/pre-shift-service";
import { noteIdParamsSchema, withdrawNoteSchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 32 (policy 8): withdraws a note (never deleted) until its date has passed. */
export const POST = apiRoute<{ noteId: string }>(
  { module: "restaurant", operation: "withdraw-pre-shift-note" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(noteIdParamsSchema, params);
    const body = await parseJsonBody(request, withdrawNoteSchema);

    return { body: await withdrawNote(getDatabase(), actor, p.noteId, body) };
  },
);
