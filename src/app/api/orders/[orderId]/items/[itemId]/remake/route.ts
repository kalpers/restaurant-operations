import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { remakeSchema } from "@/modules/kitchen/validators/kitchen-validators";
import { orderItemParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { remakeOrderItem } from "@/workflows/remake-order-item/remake-order-item";

/** Remake a sent item. The idempotency key may come in the Idempotency-Key header or the body. */
export const POST = apiRoute<{ orderId: string; itemId: string }>(
  { module: "kitchen", operation: "remake" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderItemParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(remakeSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await remakeOrderItem(getDatabase(), actor, p.orderId, p.itemId, body), status: 201 };
  },
);
