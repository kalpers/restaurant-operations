import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getPurchaseOrder, updatePurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import { orderIdParamsSchema, updateOrderSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "get-order" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);

    return { body: await getPurchaseOrder(db, actor, p.orderId) };
  },
);

export const PATCH = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "update-order" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, updateOrderSchema);

    return { body: await updatePurchaseOrder(db, actor, p.orderId, body) };
  },
);
