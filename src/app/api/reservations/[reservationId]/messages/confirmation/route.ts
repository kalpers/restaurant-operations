import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { resendConfirmation } from "@/modules/reservations/services/guest-message-service";
import { reservationIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Send a confirmed reservation's confirmation again (Phase 22, policy 16). */
export const POST = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "resend-confirmation" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { reservationId } = parseWith(reservationIdParamsSchema, params);

    return { body: await resendConfirmation(getDatabase(), actor, reservationId) };
  },
);
