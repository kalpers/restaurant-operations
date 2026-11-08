import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { moveSession } from "@/modules/restaurant/services/session-service";
import { moveSessionSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "move-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, moveSessionSchema);

    return { body: await moveSession(getDatabase(), actor, p.sessionId, body) };
  },
);
