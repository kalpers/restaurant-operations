import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createTaxCategory, listTaxCategories } from "@/modules/menu/services/tax-service";
import { createTaxCategorySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "menu", operation: "list-tax-categories" }, async () => {
  const actor = await requireApiActor();

  return { body: await listTaxCategories(getDatabase(), actor) };
});

export const POST = apiRoute({ module: "menu", operation: "create-tax-category" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createTaxCategorySchema);

  return { body: await createTaxCategory(getDatabase(), actor, body), status: 201 };
});
