import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listCounts, startCount } from "@/modules/inventory/services/count-service";
import { startCountSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "list-counts" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listCounts(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "inventory", operation: "start-count" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, startCountSchema);

    return { body: await startCount(db, actor, body), status: 201 };
  },
);
