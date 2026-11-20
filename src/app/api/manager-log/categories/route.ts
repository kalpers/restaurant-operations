import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addLogCategory, listLogCategories } from "@/modules/restaurant/services/manager-log-category-service";
import { addLogCategorySchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 33 (policy 17): the organization's log categories. */
export const GET = apiRoute({ module: "restaurant", operation: "list-manager-log-categories" }, async () => {
  const actor = await requireApiActor();

  return { body: { categories: await listLogCategories(getDatabase(), actor) } };
});

/** Phase 33 (policy 18): adds a category. */
export const POST = apiRoute({ module: "restaurant", operation: "add-manager-log-category" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, addLogCategorySchema);

  return { body: await addLogCategory(getDatabase(), actor, body), status: 201 };
});
