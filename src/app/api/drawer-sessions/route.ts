import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listDrawerSessions } from "@/modules/settlements/services/drawer-service";
import { apiRoute } from "@/shared/http/api-route";

/** Drawer sessions at the actor's Location, newest first, with running totals. */
export const GET = apiRoute({ module: "settlements", operation: "list-drawer-sessions" }, async ({ request }) => {
  const actor = await requireApiActor();
  const status = new URL(request.url).searchParams.get("status");

  return {
    body: await listDrawerSessions(getDatabase(), actor, {
      status: status === "OPEN" || status === "CLOSED" ? status : undefined,
    }),
  };
});
