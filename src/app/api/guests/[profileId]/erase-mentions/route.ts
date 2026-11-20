import { getDatabase } from "@/db";
import { requireApiActor, requireCurrentUser } from "@/modules/auth/guards";
import { guestProfileIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { previewGuestMentions, redactableLocationIds } from "@/workflows/erase-guest/erase-guest";

/** Phase 33 (policy 2): log entries and notes that may mention this guest, before an erase. */
export const GET = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "preview-guest-mentions" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const auth = await requireCurrentUser();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);

    return { body: await previewGuestMentions(getDatabase(), actor, { profileId }, redactableLocationIds(auth, actor)) };
  },
);
