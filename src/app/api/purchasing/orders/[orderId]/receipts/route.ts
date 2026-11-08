import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { receivePurchaseOrder } from "@/modules/inventory/services/receiving-service";
import { orderIdParamsSchema, receiveSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "inventory", operation: "receive-order" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, receiveSchema);

    return { body: await receivePurchaseOrder(db, actor, p.orderId, body), status: 201 };
  },
);
