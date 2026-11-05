import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { savePreferences } from "@/modules/scheduling/services/availability-service";
import { preferencesSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const PUT = apiRoute(
  { module: "scheduling", operation: "save-own-preferences" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, preferencesSchema);
    const db = getDatabase();

    return { body: await savePreferences(db, actor, { kind: "self" as const }, body) };
  },
);
