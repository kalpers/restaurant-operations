import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { suggestWaitQuote } from "@/modules/reservations/services/recommendation-service";
import { quoteQuerySchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "waitlist", operation: "suggest-quote" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const query = parseWith(
      quoteQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );

    return { body: await suggestWaitQuote(getDatabase(), actor, query) };
  },
);
