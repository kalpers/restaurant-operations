import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { seatPartySchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";
import { seatParty } from "@/workflows/seat-party/seat-party";

export const POST = apiRoute(
  { module: "restaurant", operation: "seat-party" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, seatPartySchema);

    return { body: await seatParty(getDatabase(), actor, body), status: 201 };
  },
);
