import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listOnHand } from "@/modules/inventory/queries/stock-queries";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "on-hand" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listOnHand(db, actor) };
  },
);
