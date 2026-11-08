import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listServerCandidates } from "@/modules/restaurant/services/floor-service";
import { serverCandidatesQuerySchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "restaurant", operation: "list-server-candidates" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const query = parseWith(
      serverCandidatesQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );

    return { body: { candidates: await listServerCandidates(getDatabase(), actor, query) } };
  },
);
