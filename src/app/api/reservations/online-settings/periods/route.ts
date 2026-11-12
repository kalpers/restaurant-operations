import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { replaceBookingPeriods } from "@/modules/reservations/services/online-booking-service";
import { bookingPeriodsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Replace the online booking hours (Phase 22, policy 7). */
export const PUT = apiRoute({ module: "reservations", operation: "save-booking-hours" }, async ({ request }) => {
  const actor = await requireApiActor();
  const { periods } = await parseJsonBody(request, bookingPeriodsSchema);

  return { body: await replaceBookingPeriods(getDatabase(), actor, periods) };
});
