import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { closeDrawerSession } from "@/modules/settlements/services/drawer-service";
import { closeDrawerSessionSchema, drawerSessionParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Closes a drawer session with the counted cash. Retry-safe with the same key. */
export const POST = apiRoute<{ sessionId: string }>(
  { module: "settlements", operation: "close-drawer-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(drawerSessionParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(closeDrawerSessionSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await closeDrawerSession(getDatabase(), actor, p.sessionId, body) };
  },
);
