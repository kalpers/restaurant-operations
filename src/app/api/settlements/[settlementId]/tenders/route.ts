import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordTender } from "@/modules/settlements/services/settlement-service";
import {
  recordTenderSchema,
  settlementIdParamsSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/**
 * Records a tender. The client generates the idempotency key once per tender attempt and
 * reuses it on every retry (Idempotency-Key header or body). Nothing is processed: this
 * records what happened at the register or an external card terminal.
 */
export const POST = apiRoute<{ settlementId: string }>(
  { module: "settlements", operation: "record-tender" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(settlementIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(recordTenderSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await recordTender(getDatabase(), actor, p.settlementId, body), status: 201 };
  },
);
