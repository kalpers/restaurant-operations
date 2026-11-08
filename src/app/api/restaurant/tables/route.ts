import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createTable, listTablesForConfiguration } from "@/modules/restaurant/services/table-service";
import { createTableSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "restaurant", operation: "list-tables" },
  async () => {
    const actor = await requireApiActor();

    return { body: { tables: await listTablesForConfiguration(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "restaurant", operation: "create-table" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createTableSchema);

    return { body: await createTable(getDatabase(), actor, body), status: 201 };
  },
);
