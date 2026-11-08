import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { closeAvailabilityWindow } from "@/modules/menu/services/catalog-service";
import { windowIdParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ windowId: string }>(
  { module: "menu", operation: "close-availability" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(windowIdParamsSchema, params);

    return { body: await closeAvailabilityWindow(db, actor, p.windowId) };
  },
);
