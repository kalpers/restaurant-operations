import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { notifyWaitlistEntry } from "@/modules/reservations/services/waitlist-service";
import { expectedVersionSchema, entryIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ entryId: string }>(
  { module: "waitlist", operation: "notify-waitlist-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await notifyWaitlistEntry(getDatabase(), actor, p.entryId, body) };
  },
);
