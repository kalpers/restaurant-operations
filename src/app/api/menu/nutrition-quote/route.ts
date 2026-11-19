import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { quoteNutrition } from "@/modules/menu/services/nutrition-quote-service";
import { validateSelectionSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 28 (policy 12): nutrition of one item with these modifiers, for the order screen. */
export const POST = apiRoute({ module: "menu", operation: "nutrition-quote" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, validateSelectionSchema);

  return { body: await quoteNutrition(getDatabase(), actor, { menuItemId: body.menuItemId, selections: body.selections }) };
});
