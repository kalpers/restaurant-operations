import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { publishRevision } from "@/modules/recipes/services/recipe-service";
import { publishRevisionSchema, revisionParamsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "publish-revision" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    const body = await parseJsonBody(request, publishRevisionSchema);

    return { body: await publishRevision(db, actor, p.recipeId, p.revisionId, body) };
  },
);
