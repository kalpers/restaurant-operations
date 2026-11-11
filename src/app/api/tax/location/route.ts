import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getLocationTaxSetting, setLocationTaxEnabled } from "@/modules/menu/services/tax-service";
import { setLocationTaxSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Whether the actor's current Location taxes orders (Phase 17 policy A3). */
export const GET = apiRoute({ module: "menu", operation: "get-location-tax" }, async () => {
  const actor = await requireApiActor();

  return { body: await getLocationTaxSetting(getDatabase(), actor) };
});

export const PATCH = apiRoute({ module: "menu", operation: "set-location-tax" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, setLocationTaxSchema);

  return { body: await setLocationTaxEnabled(getDatabase(), actor, body) };
});
