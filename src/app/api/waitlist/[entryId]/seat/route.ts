import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { entryIdParamsSchema, seatWaitlistSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { seatWaitlistParty } from "@/workflows/seat-guest-party/seat-guest-party";

export const POST = apiRoute<{ entryId: string }>(
  { module: "waitlist", operation: "seat-waitlist-entry" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, seatWaitlistSchema);

    return {
      body: await seatWaitlistParty(getDatabase(), actor, { ...body, entryId: p.entryId }),
      status: 201,
    };
  },
);
