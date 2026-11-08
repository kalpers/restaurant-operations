import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelSession } from "@/modules/restaurant/services/session-service";
import { cancelSessionSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "cancel-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, cancelSessionSchema);

    return { body: await cancelSession(getDatabase(), actor, p.sessionId, body) };
  },
);
