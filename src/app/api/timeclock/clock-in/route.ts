import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clockIn } from "@/modules/scheduling/services/timeclock-service";
import { clockInSchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Clock in. With `employeeId`, a manager punch. Retry-safe with the same key. */
export const POST = apiRoute({ module: "scheduling", operation: "clock-in" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(clockInSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { body: await clockIn(getDatabase(), actor, body), status: 201 };
});
