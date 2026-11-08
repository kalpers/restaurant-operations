import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listLowStock } from "@/modules/inventory/queries/stock-queries";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "low-stock" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listLowStock(db, actor) };
  },
);
