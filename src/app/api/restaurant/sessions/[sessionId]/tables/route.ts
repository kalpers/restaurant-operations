import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addSessionTableSchema, sessionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { combineTableIntoSession } from "@/workflows/move-table-session/move-table-session";

export const POST = apiRoute<{ sessionId: string }>(
  { module: "restaurant", operation: "add-session-table" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionIdParamsSchema, params);
    const body = await parseJsonBody(request, addSessionTableSchema);

    return { body: await combineTableIntoSession(getDatabase(), actor, p.sessionId, body) };
  },
);
