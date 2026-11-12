import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createGuestProfile, searchGuestProfiles } from "@/modules/reservations/services/guest-profile-service";
import { createGuestProfileSchema, guestSearchSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Guest picker and Guests page search (Phase 21, policy 2). Never cached. */
export const GET = apiRoute({ module: "reservations", operation: "search-guests" }, async ({ request }) => {
  const actor = await requireApiActor();
  const { q } = parseWith(guestSearchSchema, Object.fromEntries(new URL(request.url).searchParams));

  return {
    response: Response.json(await searchGuestProfiles(getDatabase(), actor, q), {
      headers: { "Cache-Control": "private, no-store" },
    }),
  };
});

export const POST = apiRoute({ module: "reservations", operation: "create-guest" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createGuestProfileSchema);

  return { status: 201, body: await createGuestProfile(getDatabase(), actor, body) };
});
