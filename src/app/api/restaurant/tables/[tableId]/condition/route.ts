import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { changeTableCondition } from "@/modules/restaurant/services/table-service";
import { changeConditionSchema, tableIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ tableId: string }>(
  { module: "restaurant", operation: "change-table-condition" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(tableIdParamsSchema, params);
    const body = await parseJsonBody(request, changeConditionSchema);

    return { body: await changeTableCondition(getDatabase(), actor, p.tableId, body) };
  },
);
