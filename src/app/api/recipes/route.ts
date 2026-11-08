import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createRecipe, listRecipes } from "@/modules/recipes/services/recipe-service";
import { createRecipeSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "recipes", operation: "list-recipes" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listRecipes(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "recipes", operation: "create-recipe" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createRecipeSchema);

    return { body: await createRecipe(db, actor, body), status: 201 };
  },
);
