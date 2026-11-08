import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createDraftRevision } from "@/modules/recipes/services/recipe-service";
import { createDraftSchema, recipeIdParamsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ recipeId: string }>(
  { module: "recipes", operation: "create-draft" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(recipeIdParamsSchema, params);
    const body = await parseJsonBody(request, createDraftSchema);

    return { body: await createDraftRevision(db, actor, p.recipeId, body), status: 201 };
  },
);
