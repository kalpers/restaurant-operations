import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { moveSessionSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { moveTableSession } from "@/workflows/move-table-session/move-table-session";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "move-session" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, moveSessionSchema);

    return { body: await moveTableSession(getDatabase(), actor, p.sessionId, body) };
  },
);
