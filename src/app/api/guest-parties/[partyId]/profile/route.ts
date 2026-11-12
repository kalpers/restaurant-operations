import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { linkPartyToProfile, unlinkPartyProfile } from "@/modules/reservations/services/guest-profile-service";
import {
  guestPartyIdParamsSchema,
  linkPartySchema,
  unlinkPartySchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Link a visit to a guest profile, replacing any earlier link (Phase 21, policy 2). */
export const PUT = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "link-guest" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, linkPartySchema);

    return { body: await linkPartyToProfile(getDatabase(), actor, { ...body, guestPartyId: partyId }) };
  },
);

export const DELETE = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "unlink-guest" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, unlinkPartySchema);

    return { body: await unlinkPartyProfile(getDatabase(), actor, { ...body, guestPartyId: partyId }) };
  },
);
