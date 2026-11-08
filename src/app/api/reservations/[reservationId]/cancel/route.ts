import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelReservation } from "@/modules/reservations/services/reservation-service";
import { cancelReservationSchema, reservationIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "cancel-reservation" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);
    const body = await parseJsonBody(request, cancelReservationSchema);

    return { body: await cancelReservation(getDatabase(), actor, p.reservationId, body) };
  },
);
