import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getRecipeDetail, updateRecipe } from "@/modules/recipes/services/recipe-service";
import { recipeIdParamsSchema, updateRecipeSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ recipeId: string }>(
  { module: "recipes", operation: "get-recipe" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(recipeIdParamsSchema, params);

    return { body: await getRecipeDetail(db, actor, p.recipeId) };
  },
);

export const PATCH = apiRoute<{ recipeId: string }>(
  { module: "recipes", operation: "update-recipe" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(recipeIdParamsSchema, params);
    const body = await parseJsonBody(request, updateRecipeSchema);

    return { body: await updateRecipe(db, actor, p.recipeId, body) };
  },
);
