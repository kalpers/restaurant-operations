import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { assignSessionServer } from "@/modules/restaurant/services/session-service";
import { assignSessionServerSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "assign-session-server" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, assignSessionServerSchema);

    return { body: await assignSessionServer(getDatabase(), actor, p.sessionId, body) };
  },
);
