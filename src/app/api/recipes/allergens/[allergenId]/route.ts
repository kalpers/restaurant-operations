import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateAllergen } from "@/modules/recipes/services/allergen-service";
import { allergenIdParamsSchema, updateAllergenSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Rename, reorder, deactivate or reactivate an allergen (Phase 21, policy 6). */
export const PATCH = apiRoute<{ allergenId: string }>(
  { module: "recipes", operation: "update-allergen" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { allergenId } = parseWith(allergenIdParamsSchema, params);
    const body = await parseJsonBody(request, updateAllergenSchema);

    return { body: await updateAllergen(getDatabase(), actor, { allergenId, ...body }) };
  },
);
