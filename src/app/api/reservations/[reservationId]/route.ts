import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import {
  getReservation,
  updateReservation,
} from "@/modules/reservations/services/reservation-service";
import {
  reservationIdParamsSchema,
  updateReservationSchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "get-reservation" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);

    return { body: await getReservation(getDatabase(), actor, p.reservationId) };
  },
);

export const PUT = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "update-reservation" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);
    const body = await parseJsonBody(request, updateReservationSchema);

    return { body: await updateReservation(getDatabase(), actor, p.reservationId, body) };
  },
);
