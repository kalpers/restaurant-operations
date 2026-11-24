import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { changeEventStatus } from "@/modules/reservations/services/event-service";
import { changeEventStatusSchema, eventIdParamsSchema } from "@/modules/reservations/validators/event-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 7): moves an event between inquiry, tentative, confirmed and cancelled. */
export const POST = apiRoute<{ eventId: string }>(
  { module: "reservations", operation: "change-event-status" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(eventIdParamsSchema, params);
    const body = await parseJsonBody(request, changeEventStatusSchema);

    return { body: await changeEventStatus(getDatabase(), actor, p.eventId, body) };
  },
);
