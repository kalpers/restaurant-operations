import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getProfileLoyalty } from "@/modules/reservations/services/loyalty-service";
import { guestProfileIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 30 (policy 15): a profile's points, pending rewards and ledger. */
export const GET = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "guest-loyalty" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);

    return {
      response: Response.json(await getProfileLoyalty(getDatabase(), actor, profileId), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
