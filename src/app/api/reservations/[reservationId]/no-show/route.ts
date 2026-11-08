import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { markReservationNoShow } from "@/modules/reservations/services/reservation-service";
import { expectedVersionSchema, reservationIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "no-show-reservation" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await markReservationNoShow(getDatabase(), actor, p.reservationId, body) };
  },
);
