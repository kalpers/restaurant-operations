import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { eraseGuestVisit } from "@/modules/reservations/services/guest-profile-service";
import { eraseGuestVisitSchema, guestPartyIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Erase one unlinked visit's personal data (Phase 22, policy 17). */
export const POST = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "erase-guest-visit" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, eraseGuestVisitSchema);

    return { body: await eraseGuestVisit(getDatabase(), actor, { ...body, guestPartyId: partyId }) };
  },
);
