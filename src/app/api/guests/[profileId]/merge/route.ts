import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { mergeGuestProfiles } from "@/modules/reservations/services/guest-profile-service";
import { guestProfileIdParamsSchema, mergeGuestProfilesSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Merge this duplicate profile into the one kept (Phase 21, policy 3). */
export const POST = apiRoute<{ profileId: string }>(
  { module: "reservations", operation: "merge-guests" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { profileId } = parseWith(guestProfileIdParamsSchema, params);
    const body = await parseJsonBody(request, mergeGuestProfilesSchema);

    return { body: await mergeGuestProfiles(getDatabase(), actor, { ...body, duplicateProfileId: profileId }) };
  },
);
