import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { changeTaxRate, listTaxRates } from "@/modules/menu/services/tax-service";
import { changeTaxRateSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Rates at the actor's current Location. */
export const GET = apiRoute({ module: "menu", operation: "list-tax-rates" }, async () => {
  const actor = await requireApiActor();

  return { body: await listTaxRates(getDatabase(), actor) };
});

export const POST = apiRoute({ module: "menu", operation: "change-tax-rate" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, changeTaxRateSchema);

  return { body: await changeTaxRate(getDatabase(), actor, body), status: 201 };
});
