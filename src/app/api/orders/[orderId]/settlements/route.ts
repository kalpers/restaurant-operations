import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Opens a settlement, or returns the one already OPEN for this order. */
export const POST = apiRoute<{ orderId: string }>(
  { module: "settlements", operation: "open-settlement" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);
    const result = await openSettlement(getDatabase(), actor, p.orderId);

    return { body: result, status: result.existing ? 200 : 201 };
  },
);
