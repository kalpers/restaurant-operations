import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createDrawer, listDrawers } from "@/modules/settlements/services/drawer-service";
import { createDrawerSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Cash drawers at the actor's current Location, each with its open session if any. */
export const GET = apiRoute({ module: "settlements", operation: "list-drawers" }, async () => {
  const actor = await requireApiActor();

  return { body: await listDrawers(getDatabase(), actor) };
});

export const POST = apiRoute({ module: "settlements", operation: "create-drawer" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createDrawerSchema);

  return { body: await createDrawer(getDatabase(), actor, body), status: 201 };
});
