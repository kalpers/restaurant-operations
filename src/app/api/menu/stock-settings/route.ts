import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getAuto86Setting, setAuto86FromStock } from "@/modules/menu/services/outage-service";
import { auto86SettingSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Whether the actor's Location 86es items from stock (Phase 19, policy A4). */
export const GET = apiRoute({ module: "menu", operation: "get-auto-86-setting" }, async () => {
  const actor = await requireApiActor();

  return { body: await getAuto86Setting(getDatabase(), actor) };
});

export const PATCH = apiRoute({ module: "menu", operation: "set-auto-86-setting" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, auto86SettingSchema);

  return { body: await setAuto86FromStock(getDatabase(), actor, body) };
});
