import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { transferStock } from "@/modules/inventory/services/stock-operations";
import { transferSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "inventory", operation: "transfer-stock" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, transferSchema);

    return { body: await transferStock(db, actor, body), status: 201 };
  },
);
