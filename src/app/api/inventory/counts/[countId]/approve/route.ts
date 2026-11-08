import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { approveCount } from "@/modules/inventory/services/count-service";
import { approveCountSchema, countIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ countId: string }>(
  { module: "inventory", operation: "approve-count" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(countIdParamsSchema, params);
    const body = await parseJsonBody(request, approveCountSchema);

    return { body: await approveCount(db, actor, p.countId, body) };
  },
);
