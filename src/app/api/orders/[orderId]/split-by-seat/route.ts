import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema, splitBySeatSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { splitCheckBySeat } from "@/workflows/split-by-seat/split-by-seat";

/** Phase 29 (policy 9): one check per seat, in one step. */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "split-by-seat" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(splitBySeatSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await splitCheckBySeat(getDatabase(), actor, p.orderId, body) };
  },
);
