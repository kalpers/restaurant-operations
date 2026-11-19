import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createPricePeriod, listPricePeriods } from "@/modules/menu/services/price-period-service";
import { pricePeriodSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 28: the location's price periods ("happy hour"). */
export const GET = apiRoute({ module: "menu", operation: "list-price-periods" }, async () => {
  const actor = await requireApiActor();

  return { body: await listPricePeriods(getDatabase(), actor) };
});

export const POST = apiRoute({ module: "menu", operation: "create-price-period" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, pricePeriodSchema);

  return { body: await createPricePeriod(getDatabase(), actor, body), status: 201 };
});
