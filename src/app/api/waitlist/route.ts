import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addToWaitlist, listWaitlist } from "@/modules/reservations/services/waitlist-service";
import { addToWaitlistSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "waitlist", operation: "list-waitlist" },
  async () => {
    const actor = await requireApiActor();

    return { body: { entries: await listWaitlist(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "waitlist", operation: "add-to-waitlist" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, addToWaitlistSchema);

    return { body: await addToWaitlist(getDatabase(), actor, body), status: 201 };
  },
);
