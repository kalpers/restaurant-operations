import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { redactNote } from "@/modules/restaurant/services/pre-shift-service";
import { noteIdParamsSchema, redactNoteSchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 33 (policy 5, amendment 6): redacts a note once, with a reason. Audited. */
export const POST = apiRoute<{ noteId: string }>(
  { module: "restaurant", operation: "redact-pre-shift-note" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(noteIdParamsSchema, params);
    const body = await parseJsonBody(request, redactNoteSchema);

    return { body: await redactNote(getDatabase(), actor, p.noteId, body) };
  },
);
