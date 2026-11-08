import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getCount } from "@/modules/inventory/services/count-service";
import { countIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ countId: string }>(
  { module: "inventory", operation: "get-count" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(countIdParamsSchema, params);

    return { body: await getCount(db, actor, p.countId) };
  },
);
