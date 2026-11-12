import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidItemShare } from "@/modules/orders/services/share-service";
import { orderShareParamsSchema, voidShareSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Void one share of a shared item, for money only (Phase 20, policy 17). */
export const POST = apiRoute<{ orderId: string; shareId: string }>(
  { module: "orders", operation: "void-share" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId, shareId } = parseWith(orderShareParamsSchema, params);
    const body = await parseJsonBody(request, voidShareSchema);

    return { body: await voidItemShare(getDatabase(), actor, orderId, shareId, body) };
  },
);
