import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clockOut } from "@/modules/scheduling/services/timeclock-service";
import { clockOutSchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Clock out. With `entryId`, a manager punch. Retry-safe with the same key. */
export const POST = apiRoute({ module: "scheduling", operation: "clock-out" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(clockOutSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { body: await clockOut(getDatabase(), actor, body) };
});
