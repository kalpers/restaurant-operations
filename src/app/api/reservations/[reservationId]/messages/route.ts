import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listGuestMessages } from "@/modules/reservations/services/guest-message-service";
import { reservationIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** A reservation's guest message history (Phase 22, policy 16). Never a message body. */
export const GET = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "list-reservation-messages" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { reservationId } = parseWith(reservationIdParamsSchema, params);

    return { body: { messages: await listGuestMessages(getDatabase(), actor, { reservationId }) } };
  },
);
