import { getDatabase } from "@/db";
import { requireApiActor, requireCurrentUser } from "@/modules/auth/guards";
import { guestPartyIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { previewGuestMentions, redactableLocationIds } from "@/workflows/erase-guest/erase-guest";

/** Phase 33 (policy 2): log entries and notes that may mention this visit's guest. */
export const GET = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "preview-visit-mentions" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const auth = await requireCurrentUser();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);

    return {
      body: await previewGuestMentions(getDatabase(), actor, { guestPartyId: partyId }, redactableLocationIds(auth, actor)),
    };
  },
);
