import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { apiRoute } from "@/shared/http/api-route";

const ORDER_TYPES = new Set(["DINE_IN", "BAR", "TAKEOUT"]);

export const GET = apiRoute(
  { module: "menu", operation: "operational-menu" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    // Phase 28 (policy 3): prices for this order type, so "happy hour" shows where it applies.
    const requested = new URL(request.url).searchParams.get("orderType");
    const orderType = requested && ORDER_TYPES.has(requested) ? requested : null;

    return { body: await getOperationalMenu(db, actor, new Date(), { orderType }) };
  },
);
