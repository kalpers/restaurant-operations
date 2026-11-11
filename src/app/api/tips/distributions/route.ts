import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listDistributions } from "@/modules/settlements/services/tip-service";
import { finalizeTipsSchema, tipRangeQuerySchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { finalizeTipDistribution } from "@/workflows/finalize-tip-distribution/finalize-tip-distribution";

/** Distributions in a date range, with their lines. */
export const GET = apiRoute({ module: "settlements", operation: "list-tip-distributions" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(tipRangeQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: await listDistributions(getDatabase(), actor, query) };
});

/** Finalize a business date's tips. Retry-safe with the same key. */
export const POST = apiRoute({ module: "settlements", operation: "finalize-tips" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(finalizeTipsSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { body: await finalizeTipDistribution(getDatabase(), actor, body), status: 201 };
});
