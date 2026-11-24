import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { createEvent, listEvents } from "@/modules/reservations/services/event-service";
import { createEventSchema, eventListQuerySchema } from "@/modules/reservations/validators/event-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 7): events starting in a range of business dates. */
export const GET = apiRoute({ module: "reservations", operation: "list-events" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(eventListQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: { events: await listEvents(getDatabase(), actor, query) } };
});

/** Books an event as an inquiry, a tentative hold or confirmed. */
export const POST = apiRoute({ module: "reservations", operation: "create-event" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createEventSchema);

  return { body: await createEvent(getDatabase(), actor, body), status: 201 };
});
