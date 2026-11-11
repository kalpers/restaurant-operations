import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidEntry } from "@/modules/scheduling/services/timeclock-service";
import { entryIdParamsSchema, voidEntrySchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Void an entry made by mistake. It stays, as VOIDED, and counts nowhere. */
export const POST = apiRoute<{ entryId: string }>(
  { module: "scheduling", operation: "void-time-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, voidEntrySchema);

    return { body: await voidEntry(getDatabase(), actor, p.entryId, body) };
  },
);
