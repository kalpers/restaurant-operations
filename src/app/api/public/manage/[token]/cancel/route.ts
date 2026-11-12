import { getDatabase } from "@/db";
import { publicRequestContext } from "@/modules/reservations/public-request";
import { cancelReservationByGuest } from "@/modules/reservations/services/online-booking-service";
import { publicTokenParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Public, signed out (Phase 22, policy 11): the guest cancels through the private link. */
export const POST = apiRoute<{ token: string }>(
  { module: "reservations", operation: "public-cancel" },
  async ({ request, params }) => {
    const { token } = parseWith(publicTokenParamsSchema, params);

    return { body: await cancelReservationByGuest(getDatabase(), token, publicRequestContext(request)) };
  },
);
