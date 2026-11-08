import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordAdjustment } from "@/modules/inventory/services/stock-operations";
import { adjustmentSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "inventory", operation: "record-adjustment" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, adjustmentSchema);

    return { body: await recordAdjustment(db, actor, body), status: 201 };
  },
);
