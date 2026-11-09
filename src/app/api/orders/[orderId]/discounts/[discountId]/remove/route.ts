import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeDiscount } from "@/modules/orders/services/discount-service";
import { orderDiscountParamsSchema, removeDiscountSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Removes an order- or item-level discount on this order. */
export const POST = apiRoute<{ orderId: string; discountId: string }>(
  { module: "orders", operation: "remove-discount" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderDiscountParamsSchema, params);
    const body = await parseJsonBody(request, removeDiscountSchema);

    return { body: await removeDiscount(getDatabase(), actor, p.orderId, p.discountId, body) };
  },
);
