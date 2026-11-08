import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { completeSession } from "@/modules/restaurant/services/session-service";
import { expectedVersionSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "complete-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await completeSession(getDatabase(), actor, p.sessionId, body) };
  },
);
