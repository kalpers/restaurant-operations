import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { copyIngredients } from "@/modules/recipes/services/ingredient-service";
import { copyIngredientsSchema, revisionParamsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "copy-ingredients" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    const body = await parseJsonBody(request, copyIngredientsSchema);

    return { body: await copyIngredients(db, actor, p.recipeId, p.revisionId, body) };
  },
);
