import { getDatabase } from "@/db";
import { publicRequestContext } from "@/modules/reservations/public-request";
import { getPublicAvailability } from "@/modules/reservations/services/online-booking-service";
import {
  publicAvailabilityQuerySchema,
  publicLocationParamsSchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Public, signed out (Phase 22, policy 8): the times offered for a date and party size. */
export const GET = apiRoute<{ code: string }>(
  { module: "reservations", operation: "public-availability" },
  async ({ request, params }) => {
    const { code } = parseWith(publicLocationParamsSchema, params);
    const query = parseWith(publicAvailabilityQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

    return {
      body: await getPublicAvailability(
        getDatabase(),
        code,
        { localDate: query.date, partySize: query.partySize },
        publicRequestContext(request),
      ),
    };
  },
);
