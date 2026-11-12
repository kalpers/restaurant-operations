import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { eraseGuestProfile } from "@/modules/reservations/services/guest-profile-service";
import { eraseGuestProfileSchema, guestProfileIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Erase a profile's personal data (Phase 21, policy 4). */
export const POST = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "erase-guest" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, eraseGuestProfileSchema);

    return { body: await eraseGuestProfile(getDatabase(), actor, { ...body, profileId }) };
  },
);
