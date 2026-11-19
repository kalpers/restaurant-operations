import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getLoyaltyProgram, updateLoyaltyProgram } from "@/modules/reservations/services/loyalty-service";
import { loyaltyProgramSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 30 (policy 5): the organization's loyalty program. */
export const GET = apiRoute({ module: "reservations", operation: "loyalty-program" }, async () => {
  const actor = await requireApiActor();

  return { body: await getLoyaltyProgram(getDatabase(), actor) };
});

export const PUT = apiRoute({ module: "reservations", operation: "update-loyalty-program" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, loyaltyProgramSchema);

  return { body: await updateLoyaltyProgram(getDatabase(), actor, body) };
});
