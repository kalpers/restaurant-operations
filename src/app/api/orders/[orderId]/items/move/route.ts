import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { moveItemsSchema, orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { moveOrderItems } from "@/workflows/move-order-items/move-order-items";

/** Split checks (Phase 17): moves items to another check at the table, or a new check. */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "move-items" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(moveItemsSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await moveOrderItems(getDatabase(), actor, p.orderId, body) };
  },
);
