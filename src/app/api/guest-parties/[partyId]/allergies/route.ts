import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordPartyAllergy, removePartyAllergy } from "@/modules/reservations/services/party-allergy-service";
import {
  guestPartyIdParamsSchema,
  partyAllergySchema,
  removePartyAllergySchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Add or change one of a visit's allergies (Phase 21, policy 8). */
export const POST = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "record-party-allergy" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, partyAllergySchema);

    return { body: await recordPartyAllergy(getDatabase(), actor, { ...body, guestPartyId: partyId }) };
  },
);

export const DELETE = apiRoute<{ partyId: string }>(
  { module: "reservations", operation: "remove-party-allergy" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { partyId } = parseWith(guestPartyIdParamsSchema, params);
    const body = await parseJsonBody(request, removePartyAllergySchema);

    return { body: await removePartyAllergy(getDatabase(), actor, { ...body, guestPartyId: partyId }) };
  },
);
