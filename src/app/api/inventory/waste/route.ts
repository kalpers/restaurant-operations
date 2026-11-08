import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordWaste } from "@/modules/inventory/services/stock-operations";
import { wasteSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "inventory", operation: "record-waste" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, wasteSchema);

    return { body: await recordWaste(db, actor, body), status: 201 };
  },
);
