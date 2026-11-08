import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { deleteDraftRevision, updateDraftRevision } from "@/modules/recipes/services/recipe-service";
import { revisionParamsSchema, updateDraftSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "update-draft" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    const body = await parseJsonBody(request, updateDraftSchema);

    return { body: await updateDraftRevision(db, actor, p.recipeId, p.revisionId, body) };
  },
);

export const DELETE = apiRoute<{ recipeId: string; revisionId: string }>(
  { module: "recipes", operation: "delete-draft" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(revisionParamsSchema, params);
    await deleteDraftRevision(db, actor, p.recipeId, p.revisionId).then(() => undefined);

    return {};
  },
);
