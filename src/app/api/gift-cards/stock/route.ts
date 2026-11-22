import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listStockBatches, registerStockBatch } from "@/modules/settlements/services/gift-card-stock-service";
import { registerStockBatchSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 34 (policy 10): registered card stock, newest batch first. */
export const GET = apiRoute({ module: "settlements", operation: "list-gift-card-stock" }, async () => {
  const actor = await requireApiActor();

  return { body: { batches: await listStockBatches(getDatabase(), actor) } };
});

/**
 * Phase 34 (policies 7–8): registers a box of supplier cards, all or nothing. Retry-safe with
 * the same key. The codes are never echoed back, stored or logged; only their hashes are kept.
 */
export const POST = apiRoute({ module: "settlements", operation: "register-gift-card-stock" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(registerStockBatchSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { response: Response.json(await registerStockBatch(getDatabase(), actor, body), { status: 201, headers: { "Cache-Control": "no-store" } }) };
});
