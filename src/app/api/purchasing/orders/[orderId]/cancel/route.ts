import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelPurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import { cancelOrderSchema, orderIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "cancel-order" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, cancelOrderSchema);

    return { body: await cancelPurchaseOrder(db, actor, p.orderId, body) };
  },
);
