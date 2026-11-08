import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { reservationIdParamsSchema, seatReservationSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { seatReservationParty } from "@/workflows/seat-guest-party/seat-guest-party";

export const POST = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "seat-reservation" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);
    const body = await parseJsonBody(request, seatReservationSchema);

    return {
      body: await seatReservationParty(getDatabase(), actor, {
        ...body,
        reservationId: p.reservationId,
      }),
      status: 201,
    };
  },
);
