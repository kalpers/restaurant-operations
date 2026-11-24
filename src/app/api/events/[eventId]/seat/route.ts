import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { eventIdParamsSchema, seatEventSchema } from "@/modules/reservations/validators/event-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { seatEventParty } from "@/workflows/seat-guest-party/seat-guest-party";

/** Phase 36 (policy 7): seats a confirmed event as one table session on its space. */
export const POST = apiRoute<{ eventId: string }>({ module: "reservations", operation: "seat-event" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(eventIdParamsSchema, params);
  const body = await parseJsonBody(request, seatEventSchema);

  return { body: await seatEventParty(getDatabase(), actor, { eventId: p.eventId, ...body }), status: 201 };
});
