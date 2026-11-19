import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderItemParamsSchema, setItemSeatSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { setItemSeat } from "@/workflows/set-item-seat/set-item-seat";

/** Phase 29 (policy 5): set or clear an item's seat, draft or sent. */
export const PATCH = apiRoute<{ orderId: string; itemId: string }>(
  { module: "orders", operation: "set-item-seat" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const body = await parseJsonBody(request, setItemSeatSchema);

    return { body: await setItemSeat(getDatabase(), actor, p.orderId, p.itemId, body) };
  },
);
