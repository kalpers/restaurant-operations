import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { seatWalkInSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";
import { seatWalkIn } from "@/workflows/seat-guest-party/seat-guest-party";

export const POST = apiRoute(
  { module: "waitlist", operation: "seat-walk-in" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, seatWalkInSchema);

    return { body: await seatWalkIn(getDatabase(), actor, body), status: 201 };
  },
);
