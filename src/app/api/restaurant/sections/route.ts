import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createSection, listSections } from "@/modules/restaurant/services/section-service";
import { createSectionSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "restaurant", operation: "list-sections" },
  async () => {
    const actor = await requireApiActor();

    return { body: { sections: await listSections(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "restaurant", operation: "create-section" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createSectionSchema);

    return { body: await createSection(getDatabase(), actor, body), status: 201 };
  },
);
