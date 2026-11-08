import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addPurchaseOrderLine } from "@/modules/inventory/services/purchase-order-service";
import { addOrderLineSchema, orderIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "add-order-line" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, addOrderLineSchema);

    return { body: await addPurchaseOrderLine(db, actor, p.orderId, body), status: 201 };
  },
);
