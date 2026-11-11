import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getTimeClockBoard } from "@/modules/scheduling/services/timeclock-service";
import { boardQuerySchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Everyone's time at the location: on the clock, missed clock-outs, a day's entries. */
export const GET = apiRoute({ module: "scheduling", operation: "get-time-clock-board" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(boardQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: await getTimeClockBoard(getDatabase(), actor, { businessDate: query.date }) };
});
