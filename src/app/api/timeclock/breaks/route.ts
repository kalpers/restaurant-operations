import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordBreak } from "@/modules/scheduling/services/timeclock-service";
import { breakSchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Start or end a break on the caller's own open entry. Retry-safe with the same key. */
export const POST = apiRoute({ module: "scheduling", operation: "record-break" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(breakSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { body: await recordBreak(getDatabase(), actor, body) };
});
