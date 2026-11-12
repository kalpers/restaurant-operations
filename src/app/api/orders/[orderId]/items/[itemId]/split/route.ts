import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderItemParamsSchema, splitItemSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { splitOrderItem } from "@/workflows/split-order-item/split-order-item";

/** Share one sent item between checks on the same table (Phase 20, policy 17). */
export const POST = apiRoute<{ orderId: string; itemId: string }>(
  { module: "orders", operation: "split-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId, itemId } = parseWith(orderItemParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(splitItemSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await splitOrderItem(getDatabase(), actor, orderId, itemId, body) };
  },
);
