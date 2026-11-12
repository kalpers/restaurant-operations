import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setGuestProfileAllergies } from "@/modules/reservations/services/guest-profile-service";
import { guestProfileIdParamsSchema, setGuestAllergiesSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Replace a profile's allergies (Phase 21, policy 7). */
export const PUT = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "set-guest-allergies" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, setGuestAllergiesSchema);

    return { body: await setGuestProfileAllergies(getDatabase(), actor, { ...body, profileId }) };
  },
);
