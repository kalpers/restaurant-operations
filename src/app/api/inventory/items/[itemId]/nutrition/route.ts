import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setIngredientNutrition } from "@/modules/recipes/services/nutrition-service";
import { setIngredientNutritionSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ itemId: z.uuid() });

/** Phase 28 (policy 11): an ingredient's nutrition per amount of its base unit. */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "recipes", operation: "set-ingredient-nutrition" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, setIngredientNutritionSchema);

    return { body: await setIngredientNutrition(getDatabase(), actor, { inventoryItemId: itemId, ...body }) };
  },
);
