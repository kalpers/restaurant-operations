import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getEvent, updateEvent } from "@/modules/reservations/services/event-service";
import { eventIdParamsSchema, updateEventSchema } from "@/modules/reservations/validators/event-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 7): one event, with its party's spend so far. */
export const GET = apiRoute<{ eventId: string }>({ module: "reservations", operation: "get-event" }, async ({ params }) => {
  const actor = await requireApiActor();
  const p = parseWith(eventIdParamsSchema, params);

  return { body: await getEvent(getDatabase(), actor, p.eventId) };
});

/** Changes an open event; a held event's new time or space must be free. */
export const PATCH = apiRoute<{ eventId: string }>({ module: "reservations", operation: "update-event" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(eventIdParamsSchema, params);
  const body = await parseJsonBody(request, updateEventSchema);

  return { body: await updateEvent(getDatabase(), actor, p.eventId, body) };
});
