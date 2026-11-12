import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getGuestVisits } from "@/modules/reservations/queries/guest-visits";
import { guestProfileIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** A profile's visit history, worked out from snapshots (Phase 21, policy 5). */
export const GET = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "guest-visits" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);

    return {
      response: Response.json(await getGuestVisits(getDatabase(), actor, profileId), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
