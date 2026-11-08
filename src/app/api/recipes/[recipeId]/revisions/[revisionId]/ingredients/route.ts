import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addIngredient } from "@/modules/recipes/services/ingredient-service";
import { addIngredientSchema, revisionParamsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "add-ingredient" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    const body = await parseJsonBody(request, addIngredientSchema);

    return { body: await addIngredient(db, actor, p.recipeId, p.revisionId, body), status: 201 };
  },
);
