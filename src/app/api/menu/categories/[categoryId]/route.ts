import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateCategory } from "@/modules/menu/services/catalog-service";
import { categoryIdParamsSchema, updateCategorySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ categoryId: string }>(
  { module: "menu", operation: "update-category" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(categoryIdParamsSchema, params);
    const body = await parseJsonBody(request, updateCategorySchema);

    return { body: await updateCategory(db, actor, p.categoryId, body) };
  },
);
