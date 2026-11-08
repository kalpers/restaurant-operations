import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createCategory, listCategories } from "@/modules/menu/services/catalog-service";
import { createCategorySchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-categories" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listCategories(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-category" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createCategorySchema);

    return { body: await createCategory(db, actor, body), status: 201 };
  },
);
