import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getStockBoard } from "@/modules/menu/services/outage-service";
import { apiRoute } from "@/shared/http/api-route";

/** The 86 board and "N left" figures at the actor's Location (Phase 19, policy A7). */
export const GET = apiRoute({ module: "menu", operation: "stock-signals" }, async () => {
  const actor = await requireApiActor();

  return { body: await getStockBoard(getDatabase(), actor) };
});
