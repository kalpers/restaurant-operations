import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateTable } from "@/modules/restaurant/services/table-service";
import { tableIdParamsSchema, updateTableSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ tableId: string }>(
  { module: "restaurant", operation: "update-table" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(tableIdParamsSchema, params);
    const body = await parseJsonBody(request, updateTableSchema);

    return { body: await updateTable(getDatabase(), actor, p.tableId, body) };
  },
);
