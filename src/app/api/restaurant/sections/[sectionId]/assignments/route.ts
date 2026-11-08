import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { assignServerToSection } from "@/modules/restaurant/services/section-service";
import { assignSectionServerSchema, sectionIdParamsSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ sectionId: string }>(
  { module: "restaurant", operation: "assign-section-server" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sectionIdParamsSchema, params);
    const body = await parseJsonBody(request, assignSectionServerSchema);

    return { body: await assignServerToSection(getDatabase(), actor, p.sectionId, body), status: 201 };
  },
);
