import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removePurchaseOrderLine, updatePurchaseOrderLine } from "@/modules/inventory/services/purchase-order-service";
import { orderLineParamsSchema, updateOrderLineSchema, versionSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ orderId: string; lineId: string }>(
  { module: "inventory", operation: "update-order-line" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderLineParamsSchema, params);
    const body = await parseJsonBody(request, updateOrderLineSchema);

    return { body: await updatePurchaseOrderLine(db, actor, p.orderId, p.lineId, body) };
  },
);

export const DELETE = apiRoute<{ orderId: string; lineId: string }>(
  { module: "inventory", operation: "remove-order-line" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderLineParamsSchema, params);
    const body = await parseJsonBody(request, versionSchema);
    await removePurchaseOrderLine(db, actor, p.orderId, p.lineId, body.expectedVersion);

    return {};
  },
);
