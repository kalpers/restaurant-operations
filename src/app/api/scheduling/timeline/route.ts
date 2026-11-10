import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getDayTimeline } from "@/modules/scheduling/services/timeline-service";
import { timelineQuerySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** One day of the schedule at the current location. Read-only; needs `schedule.view`. */
export const GET = apiRoute(
  { module: "scheduling", operation: "get-day-timeline" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const query = parseWith(
      timelineQuerySchema,
      Object.fromEntries(
        [...new URL(request.url).searchParams].filter(([, value]) => value !== ""),
      ),
    );

    return {
      response: Response.json(await getDayTimeline(getDatabase(), actor, query), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
