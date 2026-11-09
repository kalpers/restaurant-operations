import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema, sendOrderSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

/**
 * SEND. The client generates the idempotency key once per send attempt and reuses it on
 * every retry; it may come in the Idempotency-Key header or the body.
 */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "send" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(sendOrderSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await sendOrderItems(getDatabase(), actor, p.orderId, body) };
  },
);
