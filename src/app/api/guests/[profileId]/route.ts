import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getGuestProfile, updateGuestProfile } from "@/modules/reservations/services/guest-profile-service";
import { guestProfileIdParamsSchema, updateGuestProfileSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "get-guest" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);

    return {
      response: Response.json(await getGuestProfile(getDatabase(), actor, profileId), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);

export const PATCH = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "update-guest" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, updateGuestProfileSchema);

    return { body: await updateGuestProfile(getDatabase(), actor, { ...body, profileId }) };
  },
);
