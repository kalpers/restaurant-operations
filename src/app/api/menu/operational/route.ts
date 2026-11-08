import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "operational-menu" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await getOperationalMenu(db, actor) };
  },
);
