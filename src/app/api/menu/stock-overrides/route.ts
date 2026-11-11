import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setSellAnyway } from "@/modules/menu/services/outage-service";
import { sellAnywaySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Keep selling an auto-86'd item for the rest of the business date (Phase 19, policy A5). */
export const POST = apiRoute({ module: "menu", operation: "set-sell-anyway" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, sellAnywaySchema);

  return { status: 201, body: await setSellAnyway(getDatabase(), actor, body) };
});
