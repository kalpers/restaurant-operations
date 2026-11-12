import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setMenuItemAllergens } from "@/modules/recipes/services/allergen-service";
import { setMenuItemAllergensSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ itemId: z.uuid() });

/** Replace a menu item's declared allergens and mark them reviewed (Phase 21, policy 10). */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "recipes", operation: "set-menu-item-allergens" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, setMenuItemAllergensSchema);

    return { body: await setMenuItemAllergens(getDatabase(), actor, { menuItemId: itemId, ...body }) };
  },
);
