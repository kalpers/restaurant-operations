import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { submitCount } from "@/modules/inventory/services/count-service";
import { countIdParamsSchema, versionSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ countId: string }>(
  { module: "inventory", operation: "submit-count" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(countIdParamsSchema, params);
    const body = await parseJsonBody(request, versionSchema);

    return { body: await submitCount(db, actor, p.countId, body.expectedVersion) };
  },
);
