import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeTableFromSession } from "@/modules/restaurant/services/session-service";
import { removeSessionTableSchema, sessionTableParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sessionId: string; tableId: string }>(
  { module: "restaurant", operation: "remove-session-table" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sessionTableParamsSchema, params);
    const body = await parseJsonBody(request, removeSessionTableSchema);

    return {
      body: await removeTableFromSession(getDatabase(), actor, p.sessionId, p.tableId, body),
    };
  },
);
