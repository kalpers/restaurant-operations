import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { resendFailedMessage } from "@/modules/reservations/services/guest-message-service";
import { messageIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Requeue a failed guest message (Phase 22, policy 16). */
export const POST = apiRoute<{ messageId: string }>(
  { module: "reservations", operation: "resend-guest-message" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { messageId } = parseWith(messageIdParamsSchema, params);

    return { body: await resendFailedMessage(getDatabase(), actor, messageId) };
  },
);
