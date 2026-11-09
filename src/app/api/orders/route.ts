import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listOrders } from "@/modules/orders/queries/order-queries";
import { createOrder } from "@/modules/orders/services/order-service";
import { createOrderSchema, listOrdersQuerySchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "orders", operation: "list-orders" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(
    listOrdersQuerySchema,
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  return { body: await listOrders(getDatabase(), actor, query) };
});

export const POST = apiRoute({ module: "orders", operation: "create-order" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createOrderSchema);

  return { body: await createOrder(getDatabase(), actor, body), status: 201 };
});
