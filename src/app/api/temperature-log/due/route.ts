import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listChecksDue } from "@/modules/restaurant/services/temperature-service";
import { apiRoute } from "@/shared/http/api-route";

/** Phase 36 (policy 6): each check point's last reading and whether a check is due now. */
export const GET = apiRoute({ module: "restaurant", operation: "list-temperature-checks-due" }, async () => {
  const actor = await requireApiActor();

  return { body: await listChecksDue(getDatabase(), actor) };
});
