import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getRules, saveRules } from "@/modules/scheduling/services/config-service";
import { rulesSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "get-rules" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await getRules(db, actor) };
  },
);

export const PUT = apiRoute(
  { module: "scheduling", operation: "save-rules" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, rulesSchema);
    const db = getDatabase();

    return { body: await saveRules(db, actor, body) };
  },
);
