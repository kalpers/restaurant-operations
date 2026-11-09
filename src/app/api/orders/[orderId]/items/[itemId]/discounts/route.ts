import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { applyItemDiscount } from "@/modules/orders/services/discount-service";
import { applyDiscountSchema, orderItemParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string; itemId: string }>(
  { module: "orders", operation: "apply-item-discount" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const body = await parseJsonBody(request, applyDiscountSchema);

    return {
      body: await applyItemDiscount(getDatabase(), actor, p.orderId, p.itemId, body),
      status: 201,
    };
  },
);
