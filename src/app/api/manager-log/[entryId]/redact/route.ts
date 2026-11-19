import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { redactLogEntry } from "@/modules/restaurant/services/manager-log-service";
import { logEntryIdParamsSchema, redactLogEntrySchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 32 (policy 6): empties an entry's body once, with a reason. Audited. */
export const POST = apiRoute<{ entryId: string }>(
  { module: "restaurant", operation: "redact-manager-log-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(logEntryIdParamsSchema, params);
    const body = await parseJsonBody(request, redactLogEntrySchema);

    return { body: await redactLogEntry(getDatabase(), actor, p.entryId, body) };
  },
);
