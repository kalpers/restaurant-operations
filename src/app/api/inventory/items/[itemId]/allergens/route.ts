import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setIngredientAllergens } from "@/modules/recipes/services/allergen-service";
import { setIngredientAllergensSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ itemId: z.uuid() });

/** Replace an ingredient's allergen tags and mark them reviewed (Phase 21, policy 9). */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "recipes", operation: "set-ingredient-allergens" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, setIngredientAllergensSchema);

    return { body: await setIngredientAllergens(getDatabase(), actor, { inventoryItemId: itemId, ...body }) };
  },
);
