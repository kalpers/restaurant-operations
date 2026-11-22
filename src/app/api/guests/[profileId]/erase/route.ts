import { getDatabase } from "@/db";
import { requireApiActor, requireCurrentUser } from "@/modules/auth/guards";
import { eraseGuestProfileSchema, guestProfileIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { eraseGuestProfileWithMentions, eraseSearchScope } from "@/workflows/erase-guest/erase-guest";

/**
 * Erase a profile's personal data (Phase 21, policy 4), with the log entries and notes the
 * eraser chose to redact (Phase 33, policies 2–4).
 */
export const POST = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "erase-guest" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const auth = await requireCurrentUser();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, eraseGuestProfileSchema);

    return {
      body: await eraseGuestProfileWithMentions(getDatabase(), actor, profileId, body, eraseSearchScope(auth, actor)),
    };
  },
);
