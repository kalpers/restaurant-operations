import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createPurchaseOrder, listPurchaseOrders } from "@/modules/inventory/services/purchase-order-service";
import { createOrderSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "list-orders" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listPurchaseOrders(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "inventory", operation: "create-order" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createOrderSchema);

    return { body: await createPurchaseOrder(db, actor, body), status: 201 };
  },
);
