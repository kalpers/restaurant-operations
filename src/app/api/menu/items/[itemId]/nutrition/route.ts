import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setMenuItemNutrition } from "@/modules/recipes/services/nutrition-service";
import { setMenuItemNutritionSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ itemId: z.uuid() });

/** Phase 28 (policy 12): a menu item's declared nutrition, which replaces the calculation. */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "recipes", operation: "set-menu-item-nutrition" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, setMenuItemNutritionSchema);

    return { body: await setMenuItemNutrition(getDatabase(), actor, { menuItemId: itemId, ...body }) };
  },
);
