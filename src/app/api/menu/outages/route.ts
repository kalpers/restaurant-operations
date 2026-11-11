import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { markItemOut } from "@/modules/menu/services/outage-service";
import { markItemOutSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** 86 an item at the actor's Location (Phase 19, policy A2). */
export const POST = apiRoute({ module: "menu", operation: "mark-item-out" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, markItemOutSchema);

  return { status: 201, body: await markItemOut(getDatabase(), actor, body) };
});
