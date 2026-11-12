import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { markModifierOut } from "@/modules/menu/services/outage-service";
import { markModifierOutSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** 86 a modifier at the actor's Location, now or on a schedule (Phase 20, policies 3 and 4). */
export const POST = apiRoute({ module: "menu", operation: "mark-modifier-out" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, markModifierOutSchema);

  return { status: 201, body: await markModifierOut(getDatabase(), actor, body) };
});
