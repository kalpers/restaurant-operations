import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cleanTable } from "@/modules/restaurant/services/table-service";
import { expectedVersionSchema, tableIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ tableId: string }>(
  { module: "restaurant", operation: "clean-table" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(tableIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await cleanTable(getDatabase(), actor, p.tableId, body) };
  },
);
