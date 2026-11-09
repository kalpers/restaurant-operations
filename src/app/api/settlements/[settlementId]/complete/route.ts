import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import {
  completeSettlementSchema,
  settlementIdParamsSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";

/** Completes an exactly reconciled settlement and closes its order. Idempotent. */
export const POST = apiRoute<{ settlementId: string }>(
  { module: "settlements", operation: "complete-settlement" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(settlementIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(completeSettlementSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await completeSettlement(getDatabase(), actor, p.settlementId, body) };
  },
);
