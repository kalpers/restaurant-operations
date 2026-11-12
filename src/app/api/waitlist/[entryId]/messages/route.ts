import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listGuestMessages } from "@/modules/reservations/services/guest-message-service";
import { entryIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** A waitlist entry's guest message history (Phase 22, policy 16). Never a message body. */
export const GET = apiRoute<{ entryId: string }>(
  { module: "reservations", operation: "list-waitlist-messages" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { entryId } = parseWith(entryIdParamsSchema, params);

    return { body: { messages: await listGuestMessages(getDatabase(), actor, { waitlistEntryId: entryId }) } };
  },
);
