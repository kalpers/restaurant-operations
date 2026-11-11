import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getMyTime } from "@/modules/scheduling/services/timeclock-service";
import { apiRoute } from "@/shared/http/api-route";

/** The caller's own open entry, week and overtime state (Phase 18). */
export const GET = apiRoute({ module: "scheduling", operation: "get-my-time" }, async () => {
  const actor = await requireApiActor();

  return { body: await getMyTime(getDatabase(), actor) };
});
