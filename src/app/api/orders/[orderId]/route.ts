import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getOrderDetail } from "@/modules/orders/queries/order-queries";
import { orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "get-order" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);

    return { body: await getOrderDetail(getDatabase(), actor, p.orderId) };
  },
);
