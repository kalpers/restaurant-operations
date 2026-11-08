import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { retireRevision } from "@/modules/recipes/services/recipe-service";
import { retireRevisionSchema, revisionParamsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "retire-revision" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    const body = await parseJsonBody(request, retireRevisionSchema);

    return { body: await retireRevision(db, actor, p.recipeId, p.revisionId, body) };
  },
);
