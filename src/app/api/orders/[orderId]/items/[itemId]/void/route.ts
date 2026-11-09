import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderItemParamsSchema, voidItemSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

export const POST = apiRoute<{ orderId: string; itemId: string }>(
  { module: "orders", operation: "void-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const body = await parseJsonBody(request, voidItemSchema);

    return { body: await voidOrderItem(getDatabase(), actor, p.orderId, p.itemId, body) };
  },
);
