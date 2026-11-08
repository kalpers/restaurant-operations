import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateSection } from "@/modules/restaurant/services/section-service";
import { sectionIdParamsSchema, updateSectionSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ sectionId: string }>(
  { module: "restaurant", operation: "update-section" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(sectionIdParamsSchema, params);
    const body = await parseJsonBody(request, updateSectionSchema);

    return { body: await updateSection(getDatabase(), actor, p.sectionId, body) };
  },
);
