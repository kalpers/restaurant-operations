import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getDrawerSetting, setCashDrawerRequired } from "@/modules/settlements/services/drawer-service";
import { drawerSettingSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Whether cash at the actor's Location needs an open drawer session (Phase 17). */
export const GET = apiRoute({ module: "settlements", operation: "get-drawer-setting" }, async () => {
  const actor = await requireApiActor();

  return { body: await getDrawerSetting(getDatabase(), actor) };
});

export const PATCH = apiRoute({ module: "settlements", operation: "set-drawer-setting" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, drawerSettingSchema);

  return { body: await setCashDrawerRequired(getDatabase(), actor, body) };
});
