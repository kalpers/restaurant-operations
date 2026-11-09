import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** The order's settlement view: amount due, the open or completed settlement, history. */
export const GET = apiRoute<{ orderId: string }>(
  { module: "settlements", operation: "get-order-settlement" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(orderIdParamsSchema, params);

    return { body: await getOrderSettlementView(getDatabase(), actor, p.orderId) };
  },
);
