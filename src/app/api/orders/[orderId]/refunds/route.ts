import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listRefundsForOrder, recordRefund } from "@/modules/settlements/services/refund-service";
import { orderIdParamsSchema, recordRefundSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ orderId: string }>(
  { module: "settlements", operation: "list-refunds" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);

    return { body: await listRefundsForOrder(getDatabase(), actor, p.orderId) };
  },
);

/** Records a refund on a CLOSED order (Phase 17, record only). Retry-safe with the same key. */
export const POST = apiRoute<{ orderId: string }>(
  { module: "settlements", operation: "record-refund" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(recordRefundSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await recordRefund(getDatabase(), actor, p.orderId, body), status: 201 };
  },
);
