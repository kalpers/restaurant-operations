import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeWaitlistEntry } from "@/modules/reservations/services/waitlist-service";
import { removeWaitlistSchema, entryIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ entryId: string }>(
  { module: "waitlist", operation: "remove-waitlist-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, removeWaitlistSchema);

    return { body: await removeWaitlistEntry(getDatabase(), actor, p.entryId, body) };
  },
);
