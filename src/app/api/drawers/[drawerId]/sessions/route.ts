import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { openDrawerSession } from "@/modules/settlements/services/drawer-service";
import { drawerIdParamsSchema, openDrawerSessionSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Opens a drawer session with a starting float. Retry-safe with the same key. */
export const POST = apiRoute<{ drawerId: string }>(
  { module: "settlements", operation: "open-drawer-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(drawerIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(openDrawerSessionSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await openDrawerSession(getDatabase(), actor, p.drawerId, body), status: 201 };
  },
);
