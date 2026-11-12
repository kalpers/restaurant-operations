import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createAllergen, listAllergenChoices } from "@/modules/recipes/services/allergen-service";
import { createAllergenSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";
import { assertPermission } from "@/modules/recipes/services/access";

/** The allergen list (Phase 21, policy 6). Anyone who can see the menu may read it. */
export const GET = apiRoute({ module: "recipes", operation: "list-allergens" }, async () => {
  const actor = await requireApiActor();

  assertPermission(actor, "menu.view");

  return { body: await listAllergenChoices(getDatabase(), actor) };
});

export const POST = apiRoute({ module: "recipes", operation: "create-allergen" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createAllergenSchema);

  return { status: 201, body: await createAllergen(getDatabase(), actor, body) };
});
