import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema, voidOrderSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { voidOrder } from "@/workflows/void-order-item/void-order-item";

export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "void-order" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, voidOrderSchema);

    return { body: await voidOrder(getDatabase(), actor, p.orderId, body) };
  },
);
