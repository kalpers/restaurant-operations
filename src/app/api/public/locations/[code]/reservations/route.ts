import { getDatabase } from "@/db";
import { publicRequestContext } from "@/modules/reservations/public-request";
import { createOnlineReservation } from "@/modules/reservations/services/online-booking-service";
import { onlineBookingSchema, publicLocationParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Public, signed out (Phase 22, policy 9): book a table. */
export const POST = apiRoute<{ code: string }>(
  { module: "reservations", operation: "public-book" },
  async ({ request, params }) => {
    const { code } = parseWith(publicLocationParamsSchema, params);
    const body = await parseJsonBody(request, onlineBookingSchema);

    return {
      body: await createOnlineReservation(getDatabase(), code, body, publicRequestContext(request)),
      status: 201,
    };
  },
);
