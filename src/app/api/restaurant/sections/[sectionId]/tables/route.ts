import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setSectionTables } from "@/modules/restaurant/services/section-service";
import { sectionIdParamsSchema, setSectionTablesSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ sectionId: string }>(
  { module: "restaurant", operation: "set-section-tables" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sectionIdParamsSchema, params);
    const body = await parseJsonBody(request, setSectionTablesSchema);

    return { body: await setSectionTables(getDatabase(), actor, p.sectionId, body) };
  },
);
