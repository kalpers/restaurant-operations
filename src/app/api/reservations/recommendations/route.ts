import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recommendTablesFor } from "@/modules/reservations/services/recommendation-service";
import { recommendationQuerySchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "reservations", operation: "recommend-tables" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const query = parseWith(
      recommendationQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );

    return {
      body: await recommendTablesFor(getDatabase(), actor, {
        partySize: query.partySize,
        preferredAreaId: query.areaId,
        guestPartyId: query.guestPartyId,
      }),
    };
  },
);
