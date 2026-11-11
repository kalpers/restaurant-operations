import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateTaxCategory } from "@/modules/menu/services/tax-service";
import { taxCategoryIdParamsSchema, updateTaxCategorySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ categoryId: string }>(
  { module: "menu", operation: "update-tax-category" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(taxCategoryIdParamsSchema, params);
    const body = await parseJsonBody(request, updateTaxCategorySchema);

    return { body: await updateTaxCategory(getDatabase(), actor, p.categoryId, body) };
  },
);
