import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listSwapsForReview, openSwapForEmployee } from "@/modules/scheduling/services/swap-service";
import { swapRequestSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "list-swaps" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: { swaps: await listSwapsForReview(db, actor) } };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "open-swap" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, swapRequestSchema);
    const db = getDatabase();

    return { body: await openSwapForEmployee(db, actor, body), status: 201 };
  },
);
