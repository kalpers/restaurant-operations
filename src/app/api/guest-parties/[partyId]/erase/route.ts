import { getDatabase } from "@/db";
import { requireApiActor, requireCurrentUser } from "@/modules/auth/guards";
import { eraseGuestVisitSchema, guestPartyIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { eraseGuestVisitWithMentions, eraseSearchScope } from "@/workflows/erase-guest/erase-guest";

/**
 * Erase one unlinked visit's personal data (Phase 22, policy 17), with the log entries and
 * notes the eraser chose to redact (Phase 33, policies 2–4).
 */
export const POST = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "erase-guest-visit" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const auth = await requireCurrentUser();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, eraseGuestVisitSchema);

    return {
      body: await eraseGuestVisitWithMentions(getDatabase(), actor, partyId, body, eraseSearchScope(auth, actor)),
    };
  },
);
