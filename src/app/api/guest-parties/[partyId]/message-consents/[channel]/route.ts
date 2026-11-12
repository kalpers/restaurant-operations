import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { withdrawConsentByStaff } from "@/modules/reservations/services/guest-message-service";
import { messageChannelParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Withdraw one channel of a visit's message consent (Phase 22, policy 6). */
export const DELETE = apiRoute<{ partyId: string; channel: string }>(
  { module: "reservations", operation: "withdraw-message-consent" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { partyId, channel } = parseWith(messageChannelParamsSchema, params);

    return { body: await withdrawConsentByStaff(getDatabase(), actor, partyId, channel) };
  },
);
