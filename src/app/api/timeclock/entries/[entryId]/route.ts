import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { adjustEntry } from "@/modules/scheduling/services/timeclock-service";
import { adjustEntrySchema, entryIdParamsSchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** A manager's correction, with a reason. The original punch times are kept. */
export const PATCH = apiRoute<{ entryId: string }>(
  { module: "scheduling", operation: "adjust-time-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, adjustEntrySchema);

    return { body: await adjustEntry(getDatabase(), actor, p.entryId, body) };
  },
);
