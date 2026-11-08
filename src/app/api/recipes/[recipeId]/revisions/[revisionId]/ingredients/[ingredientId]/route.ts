import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeIngredient, updateIngredient } from "@/modules/recipes/services/ingredient-service";
import { ingredientParamsSchema, removeIngredientSchema, updateIngredientSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ recipeId: string; revisionId: string; ingredientId: string }>(
  { module: "recipes", operation: "update-ingredient" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(ingredientParamsSchema, params);
    const body = await parseJsonBody(request, updateIngredientSchema);

    return { body: await updateIngredient(db, actor, p.recipeId, p.revisionId, p.ingredientId, body) };
  },
);

export const DELETE = apiRoute<{ recipeId: string; revisionId: string; ingredientId: string }>(
  { module: "recipes", operation: "remove-ingredient" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(ingredientParamsSchema, params);
    const body = await parseJsonBody(request, removeIngredientSchema);

    return { body: await removeIngredient(db, actor, p.recipeId, p.revisionId, p.ingredientId, body.expectedVersion) };
  },
);
