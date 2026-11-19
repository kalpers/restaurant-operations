import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updatePricePeriod } from "@/modules/menu/services/price-period-service";
import { pricePeriodParamsSchema, updatePricePeriodSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ periodId: string }>(
  { module: "menu", operation: "update-price-period" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(pricePeriodParamsSchema, params);
    const body = await parseJsonBody(request, updatePricePeriodSchema);

    return { body: await updatePricePeriod(getDatabase(), actor, p.periodId, body) };
  },
);
