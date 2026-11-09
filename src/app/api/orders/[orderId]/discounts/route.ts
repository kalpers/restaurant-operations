import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { applyOrderDiscount } from "@/modules/orders/services/discount-service";
import { applyDiscountSchema, orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "apply-order-discount" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, applyDiscountSchema);

    return { body: await applyOrderDiscount(getDatabase(), actor, p.orderId, body), status: 201 };
  },
);
