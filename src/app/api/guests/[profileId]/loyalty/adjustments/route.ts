import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { adjustLoyaltyPoints } from "@/modules/reservations/services/loyalty-service";
import {
  adjustLoyaltyPointsSchema,
  guestProfileIdParamsSchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 30 (policy 12): add or remove points with a reason. */
export const POST = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "adjust-loyalty-points" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, adjustLoyaltyPointsSchema);

    return { body: await adjustLoyaltyPoints(getDatabase(), actor, profileId, body) };
  },
);
