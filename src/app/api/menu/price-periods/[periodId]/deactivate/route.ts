import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { deactivatePricePeriod } from "@/modules/menu/services/price-period-service";
import { deactivatePricePeriodSchema, pricePeriodParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ periodId: string }>(
  { module: "menu", operation: "deactivate-price-period" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(pricePeriodParamsSchema, params);
    const body = await parseJsonBody(request, deactivatePricePeriodSchema);

    return { body: await deactivatePricePeriod(getDatabase(), actor, p.periodId, body) };
  },
);
