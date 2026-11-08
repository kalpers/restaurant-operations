import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { submitPurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import { orderIdParamsSchema, versionSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "submit-order" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, versionSchema);

    return { body: await submitPurchaseOrder(db, actor, p.orderId, body.expectedVersion) };
  },
);
