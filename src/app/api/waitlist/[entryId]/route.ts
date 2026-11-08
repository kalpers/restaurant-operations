import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateWaitlistEntry } from "@/modules/reservations/services/waitlist-service";
import { entryIdParamsSchema, updateWaitlistSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ entryId: string }>(
  { module: "waitlist", operation: "update-waitlist-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, updateWaitlistSchema);

    return { body: await updateWaitlistEntry(getDatabase(), actor, p.entryId, body) };
  },
);
