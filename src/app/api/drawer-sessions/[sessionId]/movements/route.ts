import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordDrawerMovement } from "@/modules/settlements/services/drawer-service";
import { drawerMovementSchema, drawerSessionParamsSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Records a paid-in or paid-out. Retry-safe with the same key. */
export const POST = apiRoute<{ sessionId: string }>(
  { module: "settlements", operation: "record-drawer-movement" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(drawerSessionParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(drawerMovementSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await recordDrawerMovement(getDatabase(), actor, p.sessionId, body), status: 201 };
  },
);
